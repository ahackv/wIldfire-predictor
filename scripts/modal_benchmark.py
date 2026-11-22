"""Run the replay benchmark once on a Modal T4 and save the measured JSON."""

from hashlib import sha256
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import modal


SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR.parent / "data"
REPLAY_MEMBER = "norcal_next_day_replay.csv.gz"
REMOTE_SOURCE = "/opt/wildfire-replay"
CPU_CORES = 4
GPU = "T4"

app = modal.App("wildfire-replay-benchmark")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(
        "numpy==2.3.5",
        "pandas==2.2.3",
        "scipy==1.17.0",
        "scikit-learn==1.8.0",
        "threadpoolctl==3.6.0",
    )
    .uv_pip_install(
        "torch==2.8.0+cu126",
        index_url="https://pypi.org/simple",
        extra_index_url="https://download.pytorch.org/whl/cu126",
    )
    .add_local_file(SCRIPT_DIR / "build_replay.py", f"{REMOTE_SOURCE}/build_replay.py")
    .add_local_file(SCRIPT_DIR / "benchmark_parallel.py", f"{REMOTE_SOURCE}/benchmark_parallel.py")
)


def replay_bytes(path):
    if path.suffix.lower() == ".zip":
        with ZipFile(path) as archive:
            data = archive.read(REPLAY_MEMBER)
    elif path.name.lower().endswith(".csv.gz"):
        data = path.read_bytes()
    else:
        raise ValueError("Use the starter ZIP or its compressed replay CSV.")
    if not data.startswith(b"\x1f\x8b"):
        raise ValueError("The replay CSV must be gzip-compressed.")
    return data


@app.function(
    image=image,
    gpu=GPU,
    cpu=(CPU_CORES, CPU_CORES),
    memory=4096,
    max_containers=1,
    single_use_containers=True,
    retries=0,
    timeout=120,
    startup_timeout=180,
)
def run_t4(data: bytes, repeats: int) -> dict:
    sys.path.insert(0, REMOTE_SOURCE)
    from benchmark_parallel import benchmark

    with TemporaryDirectory(prefix="wildfire-replay-") as scratch:
        path = Path(scratch) / REPLAY_MEMBER
        path.write_bytes(data)
        result = benchmark(path, workers=CPU_CORES, repeats=repeats, device="cuda")
    result["modal"] = {
        "requestedGpu": GPU,
        "cpuLimitCores": CPU_CORES,
        "replaySha256": sha256(data).hexdigest(),
    }
    return result


@app.local_entrypoint()
def main(input: str, output: str = str(DATA_DIR / "benchmark-modal.json"), repeats: int = 5):
    if not 3 <= repeats <= 10:
        raise ValueError("Use between three and ten measured repetitions.")

    source = Path(input).expanduser().resolve(strict=True)
    destination = Path(output).expanduser().resolve()
    if destination in (source, (DATA_DIR / "benchmark.json").resolve()):
        raise ValueError("Choose a separate JSON path for the Modal result.")
    if destination.suffix.lower() != ".json":
        raise ValueError("The output path must end in .json.")
    if destination.exists() and not destination.is_file():
        raise ValueError("The output path must be a file.")
    destination.parent.mkdir(parents=True, exist_ok=True)

    result = run_t4.remote(replay_bytes(source), repeats)
    if not result.get("cuda"):
        raise RuntimeError("Modal returned no CUDA measurement.")
    destination.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Saved the measured Modal results to {destination}")
