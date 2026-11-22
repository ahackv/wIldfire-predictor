"""Compare direct and tiled wildfire scoring on one complete historical replay."""

import argparse
import json
import os
from pathlib import Path
import platform
from statistics import median
import sys
from time import perf_counter

import numpy as np
import scipy
from scipy.spatial.distance import cdist
from threadpoolctl import threadpool_limits

from build_replay import (
    QUERY_TILE_SIZE,
    load_replay,
    prepare_analogue_inputs,
    score_analogues,
    seasonal_prior,
    validated_split,
    write_json,
)


def score_direct_reference(past, queries, discoveries, prior):
    """Use a compiled direct squared-distance kernel on each cell's full matrix."""
    probabilities = np.empty_like(prior)
    with threadpool_limits(limits=1, user_api="blas"):
        for cell in range(past.shape[0]):
            weights = cdist(queries[cell], past[cell], metric="sqeuclidean").astype(np.float32)
            weights *= -0.5
            np.exp(weights, out=weights)
            weighted_discoveries = (weights @ discoveries[cell])[:, 0]
            probabilities[cell] = (weighted_discoveries + 10 * prior[cell]) / (weights.sum(-1) + 10)
    return probabilities


def measure(cases, repeats):
    outputs = {name: action() for name, action in cases.items()}
    samples = {name: [] for name in cases}
    names = list(cases)
    for repeat in range(repeats):
        for name in names[repeat % len(names):] + names[:repeat % len(names)]:
            start = perf_counter()
            outputs[name] = cases[name]()
            samples[name].append(perf_counter() - start)
    return outputs, {name: median(times) for name, times in samples.items()}, samples


def agreement(expected, measured):
    np.testing.assert_allclose(measured, expected, atol=1e-6, rtol=1e-6)
    expected_ranks = np.argsort(-expected, axis=0, kind="stable")
    measured_ranks = np.argsort(-measured, axis=0, kind="stable")
    expected_top_ten = np.sort(expected_ranks[:10], axis=0)
    measured_top_ten = np.sort(measured_ranks[:10], axis=0)
    return (
        float(np.max(np.abs(measured - expected))),
        int(np.all(expected_top_ten == measured_top_ten, axis=0).sum()),
        int(np.all(expected_ranks == measured_ranks, axis=0).sum()),
    )


def cpu_details():
    cpu = platform.processor() or platform.machine()
    info = Path("/proc/cpuinfo")
    if info.is_file():
        model = next((line for line in info.read_text().splitlines() if line.startswith("model name")), "")
        if model:
            cpu = model.partition(":")[2].strip()
    cpu_count = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
    quota_file = Path("/sys/fs/cgroup/cpu.max")
    quota_cores = None
    if quota_file.is_file():
        quota, period = quota_file.read_text().split()
        if quota.isdecimal():
            quota_cores = int(quota) / int(period)
    return cpu, cpu_count, quota_cores


def torch_for_cuda(device):
    if device == "cpu":
        return None
    try:
        import torch
    except ImportError:
        message = "PyTorch is unavailable. Install a CUDA-enabled PyTorch build to measure a GPU."
    else:
        if torch.cuda.is_available():
            return torch
        message = "No CUDA device is available to this PyTorch runtime."
    if device == "cuda":
        raise RuntimeError(message)
    print(f"{message} Reporting measured CPU results.", file=sys.stderr)
    return None


def score_torch_tile_batches(torch, past, queries, discoveries, prior):
    """Run the analogue score on preloaded torch float32 tensors."""
    past_squared = (past * past).sum(dim=-1)[:, None, :]
    past_transposed = past.transpose(1, 2)
    probabilities = torch.empty_like(prior)
    for start in range(0, queries.shape[1], QUERY_TILE_SIZE):
        stop = min(start + QUERY_TILE_SIZE, queries.shape[1])
        current = queries[:, start:stop]
        dot_products = torch.bmm(current, past_transposed).mul_(2)
        weights = (current * current).sum(dim=-1)[:, :, None] + past_squared
        weights.sub_(dot_products).clamp_min_(0).mul_(-0.5).exp_()
        weighted_discoveries = torch.bmm(weights, discoveries)[:, :, 0]
        probabilities[:, start:stop] = (weighted_discoveries + 10 * prior[:, start:stop]) / (weights.sum(-1) + 10)
    return probabilities


def benchmark_cuda(torch, inputs, reference, cpu_seconds, repeats):
    device = torch.device("cuda:0")
    previous_precision = torch.get_float32_matmul_precision()
    torch.set_float32_matmul_precision("highest")

    def upload():
        return tuple(torch.as_tensor(array, device=device) for array in inputs)

    try:
        with torch.inference_mode():
            uploaded = upload()
            torch.cuda.synchronize(device)

            def kernel_only():
                result = score_torch_tile_batches(torch, *uploaded)
                torch.cuda.synchronize(device)
                return result

            def transfer_inclusive():
                result = score_torch_tile_batches(torch, *upload()).cpu().numpy()
                torch.cuda.synchronize(device)
                return result

            outputs, seconds, samples = measure(
                {"kernel": kernel_only, "transferInclusive": transfer_inclusive}, repeats
            )
            kernel_agreement = agreement(reference, outputs["kernel"].cpu().numpy())
            transfer_agreement = agreement(reference, outputs["transferInclusive"])
    finally:
        torch.set_float32_matmul_precision(previous_precision)

    fastest_cpu = min(cpu_seconds.values())
    return {
        "device": torch.cuda.get_device_name(device),
        "torch": torch.__version__,
        "cudaRuntime": torch.version.cuda,
        "kernelSeconds": seconds["kernel"],
        "transferInclusiveSeconds": seconds["transferInclusive"],
        "kernelSpeedup": fastest_cpu / seconds["kernel"],
        "transferInclusiveSpeedup": fastest_cpu / seconds["transferInclusive"],
        "referenceKernelSpeedup": cpu_seconds["reference"] / seconds["kernel"],
        "referenceTransferInclusiveSpeedup": cpu_seconds["reference"] / seconds["transferInclusive"],
        "maxAbsoluteError": max(kernel_agreement[0], transfer_agreement[0]),
        "topTenAgreementDays": min(kernel_agreement[1], transfer_agreement[1]),
        "fullRankAgreementDays": min(kernel_agreement[2], transfer_agreement[2]),
        "samplesSeconds": samples,
    }


def benchmark(input_path, workers, repeats, device):
    torch = torch_for_cuda(device)
    replay = load_replay(input_path)
    history, _ = validated_split(replay, "train", "2016-01-09", "2020-12-31")
    targets, _ = validated_split(replay, "test", "2023-01-01", "2024-12-31")
    inputs = prepare_analogue_inputs(history, targets, seasonal_prior(history, targets))
    past, queries, _, _ = inputs
    cells, historical_days, features = past.shape
    days = queries.shape[1]
    cases = {
        "reference": lambda: score_direct_reference(*inputs),
        "batched": lambda: score_analogues(*inputs),
        "parallel": lambda: score_analogues(*inputs, workers=workers),
    }
    outputs, seconds, samples = measure(cases, repeats)
    reference_agreement = agreement(outputs["reference"], outputs["batched"])
    parallel_agreement = agreement(outputs["reference"], outputs["parallel"])
    cpu, cpu_count, quota_cores = cpu_details()
    result = {
        "comparisons": cells * days * historical_days,
        "cells": cells,
        "days": days,
        "historicalDaysPerCell": historical_days,
        "features": features,
        "tileDays": QUERY_TILE_SIZE,
        "repeats": repeats,
        "referenceSeconds": seconds["reference"],
        "batchedSeconds": seconds["batched"],
        "parallelSeconds": seconds["parallel"],
        "referenceTopTenAgreementDays": reference_agreement[1],
        "parallelTopTenAgreementDays": parallel_agreement[1],
        "referenceRankAgreementDays": reference_agreement[2],
        "parallelRankAgreementDays": parallel_agreement[2],
        "maxAbsoluteError": max(reference_agreement[0], parallel_agreement[0]),
        "cpu": cpu,
        "visibleCpuCount": cpu_count,
        "cpuQuotaCores": quota_cores,
        "workers": workers,
        "blasThreadsPerWorker": 1,
        "speedup": seconds["reference"] / seconds["batched"],
        "parallelSpeedup": seconds["reference"] / seconds["parallel"],
        "parallelVsBatchedSpeedup": seconds["batched"] / seconds["parallel"],
        "runtime": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__},
        "samplesSeconds": samples,
    }
    if torch is not None:
        result["cuda"] = benchmark_cuda(torch, inputs, outputs["reference"], seconds, repeats)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Starter ZIP or extracted northern California replay CSV")
    parser.add_argument("--output", type=Path, default=Path("data/benchmark.json"), help="Output JSON file")
    parser.add_argument("--repeats", type=int, default=5, help="Measured repetitions per method, after one warm-up")
    parser.add_argument("--workers", type=int, default=4, help="Number of independent CPU cell groups")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto", help="Accelerator for comparison")
    args = parser.parse_args()
    if args.repeats < 3 or not 2 <= args.workers <= 96:
        parser.error("Use at least three repetitions and between 2 and 96 CPU workers.")
    try:
        result = benchmark(args.input, args.workers, args.repeats, args.device)
    except RuntimeError as error:
        parser.exit(1, f"{error}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.output, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
