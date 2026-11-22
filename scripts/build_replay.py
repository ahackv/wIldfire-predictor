"""Generate the browser replay from the Northern California starter data."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss
from threadpoolctl import threadpool_limits


CELL_COUNT = 96
QUERY_TILE_SIZE = 16
TEST_YEARS = (2023, 2024)
DATE_COLUMNS = ["target_date", "weather_through"]
DISPLAY_WEATHER = ["tmax_c_lag2", "rhmin_pct_lag2", "wind_ms_lag2", "precip_mm_lag2"]
WEATHER_FEATURES = [
    "tmax_c_lag2",
    "precip_mm_lag2",
    "rhmin_pct_lag2",
    "wind_ms_lag2",
    "tmax_c_mean7",
    "rhmin_pct_mean7",
    "precip_mm_sum7",
]


def load_replay(input_path):
    if input_path.suffix.lower() == ".zip":
        with ZipFile(input_path) as archive:
            with archive.open("norcal_next_day_replay.csv.gz") as table:
                return pd.read_csv(table, compression="gzip", parse_dates=DATE_COLUMNS)
    return pd.read_csv(input_path, parse_dates=DATE_COLUMNS)


def validated_split(data, split, start, end):
    rows = data.loc[data.split == split].sort_values(["cell_id", "target_date"]).copy()
    dates = pd.date_range(start, end)
    expected = pd.MultiIndex.from_product([range(CELL_COUNT), dates])
    index = pd.MultiIndex.from_frame(rows[["cell_id", "target_date"]])
    if not index.equals(expected):
        raise ValueError(f"The {split} split must contain each day and cell exactly once.")
    if not ((rows.target_date - rows.weather_through).dt.days == 2).all():
        raise ValueError("Weather in the replay must end two days before the target.")
    if not (rows.any_discovery == (rows.discovery_count > 0)).all():
        raise ValueError("The discovery labels and report counts disagree.")
    return rows, dates


def seasonal_prior(history, targets):
    history_month = history.target_date.dt.month
    rates = history.groupby([history.cell_id, history_month]).any_discovery.agg(["sum", "count"])
    regional_rate = history.groupby(history_month).any_discovery.mean()
    prior = (rates["sum"] + 20 * rates.index.get_level_values(1).map(regional_rate)) / (rates["count"] + 20)
    target_index = pd.MultiIndex.from_arrays([targets.cell_id, targets.target_date.dt.month])
    return prior.reindex(target_index).to_numpy(np.float32).reshape(CELL_COUNT, -1)


def weather_matrix(rows):
    values = rows[WEATHER_FEATURES].copy()
    rain = ["precip_mm_lag2", "precip_mm_sum7"]
    values[rain] = np.log1p(values[rain])
    return values


def seasonal_features(rows, weather, centre, scale):
    normalized = (weather.to_numpy() - centre) / (scale * 0.65 * np.sqrt(len(WEATHER_FEATURES)))
    angles = 2 * np.pi * (rows.target_date.dt.dayofyear.to_numpy() - 1) / 365.25
    season = np.column_stack([np.sin(angles), np.cos(angles)]) / 0.35
    features = np.column_stack([normalized, season]).astype(np.float32)
    return np.ascontiguousarray(features.reshape(CELL_COUNT, -1, features.shape[1]))


def prepare_analogue_inputs(history, targets, prior):
    past_weather = weather_matrix(history)
    centre = past_weather.mean().to_numpy()
    scale = past_weather.std().clip(lower=1e-6).to_numpy()
    past = seasonal_features(history, past_weather, centre, scale)
    queries = seasonal_features(targets, weather_matrix(targets), centre, scale)
    discoveries = history.any_discovery.to_numpy(np.float32).reshape(CELL_COUNT, -1, 1)
    return past, queries, discoveries, prior


def score_analogue_tile_batches(past, queries, discoveries, prior):
    # Expand squared distances using row norms and matrix products. A tile keeps
    # only (cells × query dates × historical dates) working data, without a feature axis.
    past_squared = (past * past).sum(-1)[:, None, :]
    past_transposed = past.transpose(0, 2, 1)
    probabilities = np.empty_like(prior)
    for start in range(0, queries.shape[1], QUERY_TILE_SIZE):
        stop = min(start + QUERY_TILE_SIZE, queries.shape[1])
        current = queries[:, start:stop]
        # Preserve the arithmetic order of the original replay. Reuse the
        # distance buffer for the exponential weights after its last read.
        dot_products = current @ past_transposed
        dot_products *= 2
        weights = (current * current).sum(-1)[:, :, None] + past_squared
        weights -= dot_products
        np.maximum(weights, 0, out=weights)
        weights *= -0.5
        np.exp(weights, out=weights)
        weighted_discoveries = (weights @ discoveries)[:, :, 0]
        probabilities[:, start:stop] = (weighted_discoveries + 10 * prior[:, start:stop]) / (weights.sum(-1) + 10)
    return probabilities


def score_analogues(past, queries, discoveries, prior, *, workers=1):
    if not 1 <= workers <= past.shape[0]:
        raise ValueError("Use between one worker and the number of cells.")
    # Workers own disjoint cell ranges. Restrict BLAS to one thread per worker
    # so the independent tiles do not create competing native thread pools.
    with threadpool_limits(limits=1, user_api="blas"):
        if workers == 1:
            return score_analogue_tile_batches(past, queries, discoveries, prior)
        boundaries = np.linspace(0, past.shape[0], workers + 1, dtype=int)
        ranges = [slice(start, stop) for start, stop in zip(boundaries[:-1], boundaries[1:])]
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [
                pool.submit(score_analogue_tile_batches, past[group], queries[group], discoveries[group], prior[group])
                for group in ranges
            ]
            return np.concatenate([future.result() for future in futures])


def estimate_risk(history, targets, prior):
    return score_analogues(*prepare_analogue_inputs(history, targets, prior))


def top_ten_hits(probabilities, labels):
    positions = np.argsort(-probabilities, axis=0, kind="stable")[:10]
    return int(np.take_along_axis(labels, positions, axis=0).sum())


def typical_weather(history):
    observations = history.groupby([history.weather_through.dt.month, history.cell_id])[DISPLAY_WEATHER].median()
    expected = pd.MultiIndex.from_product([range(1, 13), range(CELL_COUNT)])
    values = observations.reindex(expected).to_numpy()
    return {"months": values.reshape(12, CELL_COUNT, len(DISPLAY_WEATHER)).round(3).tolist()}


def write_json(path, value):
    path.write_text(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")


def build(input_path, destination):
    replay = load_replay(input_path)
    history, _ = validated_split(replay, "train", "2016-01-09", "2020-12-31")
    targets, dates = validated_split(replay, "test", "2023-01-01", "2024-12-31")
    baseline = seasonal_prior(history, targets)
    forecasts = estimate_risk(history, targets, baseline)
    labels = targets.any_discovery.to_numpy().reshape(CELL_COUNT, -1)
    reports = targets.discovery_count.to_numpy().reshape(CELL_COUNT, -1)
    weather = targets[DISPLAY_WEATHER].to_numpy().reshape(CELL_COUNT, -1, len(DISPLAY_WEATHER))

    metrics = {
        "testDays": len(dates),
        "positives": int(labels.sum()),
        "weatherTopTen": top_ten_hits(forecasts, labels),
        "baselineTopTen": top_ten_hits(baseline, labels),
        "weatherAveragePrecision": round(average_precision_score(labels.ravel(), forecasts.ravel()), 4),
        "baselineAveragePrecision": round(average_precision_score(labels.ravel(), baseline.ravel()), 4),
        "weatherBrierScore": round(brier_score_loss(labels.ravel(), forecasts.ravel()), 4),
        "baselineBrierScore": round(brier_score_loss(labels.ravel(), baseline.ravel()), 4),
    }

    destination.mkdir(parents=True, exist_ok=True)
    for year in TEST_YEARS:
        days = {
            day.date().isoformat(): {
                "p": forecasts[:, column].astype(float).round(8).tolist(),
                "b": baseline[:, column].astype(float).round(8).tolist(),
                "n": reports[:, column].tolist(),
                "w": weather[:, column, :].tolist(),
            }
            for column, day in enumerate(dates)
            if day.year == year
        }
        write_json(destination / f"replay-{year}.json", days)
    write_json(destination / "typical-weather.json", typical_weather(history))
    write_json(destination / "metrics.json", metrics)
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Starter ZIP or extracted northern California replay CSV")
    parser.add_argument("--output", type=Path, default=Path("data"), help="Directory for generated JSON")
    args = parser.parse_args()
    print(json.dumps(build(args.input, args.output), indent=2))


if __name__ == "__main__":
    main()
