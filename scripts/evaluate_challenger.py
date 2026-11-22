"""Rebuild the replay and compare a calibrated random forest on 2023–24."""

import argparse
import json
from pathlib import Path

from matplotlib.figure import Figure
from matplotlib.ticker import PercentFormatter
import numpy as np
from sklearn.calibration import calibration_curve
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss

from build_replay import (
    CELL_COUNT,
    TEST_YEARS,
    WEATHER_FEATURES,
    build,
    load_replay,
    top_ten_hits,
    validated_split,
    write_json,
)


def model_features(rows):
    coordinates = rows[["cell_lat", "cell_lon"]].to_numpy()
    day_angle = (rows.target_date.dt.dayofyear.to_numpy() - 1) * (2 * np.pi / 365.25)
    weather = rows[WEATHER_FEATURES].to_numpy()
    return np.column_stack([coordinates, np.sin(day_angle), np.cos(day_angle), weather])


def choose_forest(history, selection):
    training_inputs = model_features(history)
    selection_inputs = model_features(selection)
    selection_labels = selection.any_discovery.to_numpy().reshape(CELL_COUNT, -1)
    best_forest = None
    best_score = (-1, -1)
    for depth, leaf_size in [(8, 80), (14, 80), (None, 40)]:
        forest = RandomForestClassifier(
            n_estimators=64,
            max_depth=depth,
            min_samples_leaf=leaf_size,
            max_samples=0.66,
            random_state=42,
            n_jobs=4,
        )
        forest.fit(training_inputs, history.any_discovery)
        probabilities = forest.predict_proba(selection_inputs)[:, 1].reshape(CELL_COUNT, -1)
        score = (
            top_ten_hits(probabilities, selection_labels),
            average_precision_score(selection_labels.ravel(), probabilities.ravel()),
        )
        print(f"2021 selection · depth {depth}, leaf {leaf_size} · {score[0]} hits, AP {score[1]:.4f}")
        if score > best_score:
            best_forest, best_score = forest, score
    print(f"Selected forest · depth {best_forest.max_depth}, leaf {best_forest.min_samples_leaf}")
    return best_forest


def log_odds(probabilities):
    bounded = np.clip(probabilities, 1e-6, 1 - 1e-6)
    return np.log(bounded / (1 - bounded)).reshape(-1, 1)


def calibrated_predictions(forest, calibration, test):
    calibration_scores = forest.predict_proba(model_features(calibration))[:, 1]
    calibrator = LogisticRegression().fit(log_odds(calibration_scores), calibration.any_discovery)
    test_scores = forest.predict_proba(model_features(test))[:, 1]
    return calibrator.predict_proba(log_odds(test_scores))[:, 1].reshape(CELL_COUNT, -1)


def plot_calibration(destination, labels, series):
    figure = Figure(figsize=(9, 5.8), layout="constrained", facecolor="#fcfaf5")
    chart = figure.subplots()
    chart.set_facecolor("#fcfaf5")
    maximum = 0.0
    for name, probabilities, color, marker in series:
        observed, predicted = calibration_curve(
            labels.ravel(), probabilities.ravel(), n_bins=10, strategy="quantile"
        )
        maximum = max(maximum, float(observed.max()), float(predicted.max()))
        chart.plot(predicted, observed, marker=marker, color=color, label=name, linewidth=2, markersize=5)
    maximum = max(0.05, float(np.ceil((maximum + 0.01) / 0.05) * 0.05))
    chart.plot([0, maximum], [0, maximum], "--", color="#72786f", linewidth=1, label="Perfect calibration")
    chart.set(xlim=(0, maximum), ylim=(0, maximum))
    chart.set_title("Predicted risk and observed wildfire reports", loc="left", fontsize=16, fontweight="semibold")
    chart.set_xlabel("Mean predicted risk in group")
    chart.set_ylabel("Observed share of days and cells with a report")
    chart.xaxis.set_major_formatter(PercentFormatter(1, decimals=0))
    chart.yaxis.set_major_formatter(PercentFormatter(1, decimals=0))
    chart.grid(color="#dddcd3", linewidth=0.7)
    chart.set_axisbelow(True)
    chart.legend(loc="upper left", frameon=False)
    figure.savefig(destination, dpi=150)


def evaluate(input_path, destination):
    replay = load_replay(input_path)
    history, _ = validated_split(replay, "train", "2016-01-09", "2020-12-31")
    validation, _ = validated_split(replay, "validation", "2021-01-01", "2022-12-31")
    selection = validation.loc[validation.target_date.dt.year == 2021]
    calibration = validation.loc[validation.target_date.dt.year == 2022]
    forest = choose_forest(history, selection)

    test, dates = validated_split(replay, "test", "2023-01-01", "2024-12-31")
    labels = test.any_discovery.to_numpy().reshape(CELL_COUNT, -1)
    estimates = calibrated_predictions(forest, calibration, test)
    metrics = build(input_path, destination)
    metrics["challenger"] = {
        "name": "Calibrated random forest",
        "topTen": top_ten_hits(estimates, labels),
        "averagePrecision": round(average_precision_score(labels.ravel(), estimates.ravel()), 4),
        "brierScore": round(brier_score_loss(labels.ravel(), estimates.ravel()), 4),
    }

    saved_days = {}
    for year in TEST_YEARS:
        saved_days.update(json.loads((destination / f"replay-{year}.json").read_text(encoding="utf-8")))
    dates = [day.date().isoformat() for day in dates]
    baseline = np.array([saved_days[day]["b"] for day in dates]).T
    weather_analogue = np.array([saved_days[day]["p"] for day in dates]).T
    plot_calibration(
        destination / "calibration.png",
        labels,
        [
            ("Location and month", baseline, "#68695f", "s"),
            ("Weather analogues", weather_analogue, "#b34723", "o"),
            ("Calibrated random forest", estimates, "#1e6358", "^"),
        ],
    )
    write_json(destination / "metrics.json", metrics)
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Starter ZIP or extracted northern California replay CSV")
    parser.add_argument("--output", type=Path, default=Path("data"), help="Directory for generated outputs")
    args = parser.parse_args()
    print(json.dumps(evaluate(args.input, args.output), indent=2))


if __name__ == "__main__":
    main()
