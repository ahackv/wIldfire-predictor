# Wildfire Finder

Replay a next-day wildfire forecast for Northern California. Browse 378 photos from 15 locations, or upload your own and enter its location and capture date. The map ranks 96 cells by estimated chance of a new wildfire discovery report on the next calendar day.

## 60-second judge demo

1. **0–15 seconds.** The app opens on a Lake Tahoe photo. Click **Present** and press **1** for the 5 July 2023 forecast. Point out the 4 July Tonzi Ranch photo, the 3 July weather cutoff and the ranked map. Press **R** to show that the top 10 captured **6 of 15** cells with a new discovery report.
2. **15–30 seconds.** Press **2** for 13 July, then **R** to reveal the outcome. The top 10 captured **0 of 4** cells with reported discoveries. The map keeps the forecast visible alongside the reports.
3. **30–45 seconds.** Switch **Risk model** to **Location + month**. Sagehen Creek moves from rank 12 to 14. Select a cell to compare its weather with the typical month.
4. **45–60 seconds.** Press **Esc** and open **Benchmark** to show the measured speedup and correctness check. The weather analogue captured 33.0% of positive cell-days in 2023–24. The location-and-month baseline captured 31.5%, and the separately tested random forest captured 28.0%.

In presentation mode, **1** returns to 5 July. The date buttons and **Reveal recorded outcome** also work with the mouse.

## Run the demo

Serve this folder with `npm run dev` or `python -m http.server 3000`, then visit [localhost:3000](http://localhost:3000). The app uses plain HTML, CSS and JavaScript. Uploaded photos stay in the browser.

Select a capture date from **31 December 2022 to 30 December 2024**. The replay covers 38° to just under 40° N and −123° to just under −120° longitude. Photos show the scene during the replay. The model scores location, season and historical weather through two days before the target.

Use the **5 July** or **13 July** shortcut to load the previous day's Tonzi Ranch or Sagehen Creek photo and run that forecast. Select a cell on the map or from **Top 10 cells** to inspect its score and compare the weather with that cell's typical weather for the month. The **Risk model** selector switches between **Weather analogue** and **Location + month**. Reveal the recorded outcome to compare the ranked cells with the reports. [Replay examples and data](DATASETS.md)

## Where the data are

- [`data/photo-weather-samples.csv`](data/photo-weather-samples.csv) pairs **62 PhenoCam photos** with the starter's weather and outcomes. There were no discovery reports on 23 target dates and at least one on eight dates. Both cameras are in the same cell.
- [`data/photos.json`](data/photos.json) describes the bundled demo photos. Each image has its source and credit.
- The searchable library opens with one photo per location. It combines 372 PhenoCam frames from nine camera sites with six dated, geotagged landscape photos from Wikimedia Commons. Rerun `python scripts/build_photo_library.py` to rebuild the camera index. [Camera index](data/photo-library.json) · [Featured locations and credits](data/featured-photos.json)
- [`data/replay-2023.json`](data/replay-2023.json) and [`data/replay-2024.json`](data/replay-2024.json) contain both score series, the input weather and recorded outcomes. [`data/typical-weather.json`](data/typical-weather.json) contains the monthly training-period weather medians.
- [`DATASETS.md`](DATASETS.md) lists the sources and what each file does. The full training data and 19-source catalogue are in the separate `Andrew_Wildfire_Hackathon_Starter.zip` attachment.

## Rebuild the replay

Use Python 3 and the starter ZIP to regenerate the replay data, benchmark and calibration chart.

```sh
python -m pip install numpy pandas scipy scikit-learn threadpoolctl matplotlib
python scripts/evaluate_challenger.py /path/to/Andrew_Wildfire_Hackathon_Starter.zip
```

## Parallel computation

Every test day is scored against the 2016–20 history within the same cell. The replay checks that each cell-day exists once, that observed weather ends two days before the target, and that each outcome agrees with the discovery count. The scores use seven weather features and two seasonal features. The outcome reveal uses the held-out discovery records.

The reference computes the squared distance by subtracting each historical feature vector from the forecast feature vector. The parallel version rewrites the same distance as `||q||² + ||h||² − 2q·h`. It precomputes historical squared norms and calculates the dot products with batched matrix multiplication in 16-day tiles. Groups of cells run independently and write disjoint parts of the output. Tiling limits the size of the intermediate distance matrices.

The benchmark timed the same **127,650,144** comparisons for each method, across 96 cells, 731 test dates and 1,819 historical days per cell. Timings are medians of five warmed scoring runs on an AMD EPYC 9V74 with a four-CPU quota. The parallel run used four independent cell groups, each with one BLAS thread.

| CPU method | Median time | Speedup over reference |
| --- | ---: | ---: |
| Compiled direct-distance reference | 0.509 s | 1.00× |
| Tiled matrix scoring, one worker | 0.351 s | 1.45× |
| Tiled matrix scoring, four workers | 0.110 s | 4.61× |

Four cell groups ran **3.17×** faster than one tiled worker. Both tiled methods matched every daily ranking across all 731 days. The largest absolute probability difference from the reference was **1.19 × 10⁻⁷**. The timer starts after input preparation and stops before ranking and writing files. [Measured timings and verification](data/benchmark.json)

```sh
python scripts/benchmark_parallel.py /path/to/Andrew_Wildfire_Hackathon_Starter.zip --device cpu
```

CUDA measurements are pending an accelerator run. In the Colab notebook, select a T4 GPU runtime, choose **Run all** and upload the starter ZIP when prompted. The benchmark runs the CPU cases first, then the same tiles on CUDA, and checks the scores and rankings against the direct CPU reference. It reports synchronized scoring times both with inputs already on the GPU and including transfers, with the fastest CPU method as the speedup comparator. Download the resulting JSON and load it into the benchmark card for the current tab. On a machine with CUDA-enabled PyTorch, the command above also accepts `--device cuda`. [Run the CUDA notebook](https://colab.research.google.com/github/ahackv/wIldfire-predictor/blob/main/notebooks/benchmark_cpu_gpu.ipynb)

## Held-out performance

The 2023–24 test set comprises 731 days across 96 cells and 2,936 positive cell-days. The capture rate counts the share of those positive cell-days that fell in each model's top 10 for the day. Average precision measures ranking across all test rows. Lower Brier scores indicate better probability estimates.

| Model | Top 10 captures | Capture rate | Average precision | Brier score |
| --- | ---: | ---: | ---: | ---: |
| Weather analogue | 968 | 33.0% | 0.1750 | 0.0369 |
| Location + month | 924 | 31.5% | 0.1661 | 0.0372 |
| Calibrated random forest | 822 | 28.0% | 0.1531 | 0.0376 |

The random forest is a separate benchmark. It was trained on 2016–20, selected on 2021 and calibrated on 2022 using the same seven weather inputs plus location and time of year. The weather analogue led on all three measures and is the default in the replay. [Metrics](data/metrics.json) · [Calibration chart](data/calibration.png)

## Project references

WildfireRFM's ranked monitoring inspired the shortlist, ClimateHacks FireWatch inspired map selection, and Satellite Vu's baseline comparison informed the evaluation. Wildfire Risk Predictor suggested a random forest as a comparison model. Wildfire Finder implements these ideas from scratch using the Northern California starter replay. [WildfireRFM](https://github.com/Binrongz/WildfireRFM) · [FireWatch](https://devpost.com/software/firewatch-2u5e4k) · [Satellite Vu](https://github.com/SatelliteVu/SatelliteVu-AWS-Disaster-Response-Hackathon) · [Wildfire Risk Predictor](https://devpost.com/software/wildfire-risk-predictor)

The [Dome Fire spread replay](spread.html) uses two observed airborne infrared perimeters 24 hours and 17 minutes apart. Compare a fixed expansion distance with the no-growth baseline, then reveal the later outline and see captured, missed and overestimated acreage. This one-incident scenario illustrates the trade-off between detecting new growth and overestimating its extent. [Satellite Vu spread experiment](https://github.com/SatelliteVu/SatelliteVu-AWS-Disaster-Response-Hackathon) · [Dome Fire observations](https://ftp.wildfire.gov/public/incident_specific_maps/calif_s/2026/2026_Dome/IR/)

## Measure on Modal

With a Modal profile authorised for the workspace holding your credits, run this from the repository root:

```sh
modal run scripts/modal_benchmark.py::main \
  --input /absolute/path/to/Andrew_Wildfire_Hackathon_Starter.zip \
  --output /absolute/path/to/benchmark-modal.json
```

One T4 container measures both CPU baselines before running the CUDA tiles. The launcher passes only the compressed replay CSV and writes the measurements locally. Import its JSON into the site's benchmark panel to show the same-machine comparison. [Modal CLI authentication](https://modal.com/docs/cli/latest/token) · [Modal GPU documentation](https://modal.com/docs/guide/gpu)
