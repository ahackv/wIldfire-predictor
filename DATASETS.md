# Wildfire forecast data

The forecast target is a **new wildfire discovery reported in a grid cell on the next calendar day**. A discovery can occur after ignition. A zero in the record means no new discovery was reported in that cell that day.

## Ground photos paired with weather and outcomes

[`data/photo-weather-samples.csv`](data/photo-weather-samples.csv) pairs one near-noon photo per day from each of the Tonzi Ranch and Vaira Ranch PhenoCam sites near Ione, California, with the Northern California starter replay. The photos cover 1–31 July 2023, and the target dates cover 2 July–1 August 2023. The 62 rows represent 31 distinct target dates. There were no reported discoveries on 23 dates (46 photo rows) and at least one reported discovery on eight dates (16 photo rows).

| Columns | Meaning |
| --- | --- |
| `camera_site`, `photo_date`, `camera_clock_time` | Site and capture date/time from the PhenoCam filename. |
| `photo_url`, `photo_index_url`, `photo_license` | Full-size JPEG, daily archive page, and licence. |
| `target_date`, `cell_id`, `cell_lat`, `cell_lon` | Next calendar day and the ID and centre of the replay cell. |
| `weather_through` and weather features | Latest weather date in the input, two days before the target. Lag-two columns contain that day's values. The seven-day summaries end on that date. Temperatures are in °C, precipitation in mm, relative humidity in percent, and wind speed in m/s. |
| `discovery_count`, `any_discovery`, `split` | The reported discoveries and binary target for that cell-day, with the original replay split. All 62 rows are in the replay's test period. |

Both cameras are in replay cell 20, centred at 38.375° N, 120.875° W. The two photos for a given date share weather and outcome data and show only parts of the cell. Use this sample to check the data join. Testing predictions at individual scenes or new sites requires paired imagery and outcomes at that scale.

[`data/photos.json`](data/photos.json) lists four demo photos with their camera coordinates, capture dates, and source pages. Images are credited to the PhenoCam Network under CC BY 4.0. [Tonzi archive](https://phenocam.nau.edu/webcam/browse/tonzi/2023/07/) · [Vaira archive](https://phenocam.nau.edu/webcam/browse/vaira/2023/07/) · [PhenoCam data licence and attribution](https://phenocam.nau.edu/webcam/fairuse_statement/) · [NASA archive catalogue](https://search.earthdata.nasa.gov/search/granules?p=C3446198161-ORNL_CLOUD)

### Photo library

The photo library indexes 356 near-noon images from Tonzi Ranch, Vaira Ranch, Sagehen Creek, Hill Slough and Bouldin Island. It covers selected months in 2023 and 2024 across four replay cells. The images match 295 distinct next-day cell outcomes, with 27 cell-days with a reported discovery and 268 without one. The catalogue supplies capture dates, coordinates, thumbnail and full-image links, source pages and PhenoCam credit. The replay supplies outcomes when revealed. Multiple photos can share a cell and date, and the catalogue is a showcase of archive coverage. [Photo library JSON](data/photo-library.json) · [Catalogue generator](scripts/build_photo_library.py) · [PhenoCam API](https://phenocam.nau.edu/webcam/tools/api/) · [PhenoCam data licence and attribution](https://phenocam.nau.edu/webcam/fairuse_statement/)

### July replay examples

The shortcut dates are forecast targets. Each selects the previous day's Tonzi Ranch photo. The estimates and ranks below use **Weather analogue** and refer to the camera's grid cell.

| Target | Photo date | Weather available through | Maximum temp. | Minimum humidity | Wind | Rain | Estimate and rank | Recorded discoveries |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |
| 5 July 2023 | 4 July | 3 July | 37.45°C | 21.0% | 2.8 m/s | 0 mm | 9.95%, 32nd of 96 | 1 |
| 13 July 2023 | 12 July | 11 July | 35.95°C | 17.8% | 2.5 m/s | 0 mm | 8.85%, 35th of 96 | 0 |

On 5 July, the top 10 contained six of the 15 cells with reported discoveries. On 13 July, all four cells with reported discoveries fell outside the top 10. Each positive cell-day is counted once in this comparison even when it has more than one recorded discovery. [Replay data](data/replay-2023.json) · [Matched photo and weather data](data/photo-weather-samples.csv)

## Starter archive

`Andrew_Wildfire_Hackathon_Starter.zip` is the separate attachment to “SoTA wildfire project — training data, replay notebook, 19 datasets and compute credits”. It contains `START_HERE.md`, the runnable `wildfire_gpu_replay.ipynb` notebook, three compressed training and source CSVs, and `dataset_catalogue.csv`. The catalogue lists 19 external datasets with coverage, suggested uses, and provider download links.

| File in starter archive | Contents and provenance |
| --- | --- |
| `norcal_next_day_replay.csv.gz` | 314,880 labelled rows across 96 quarter-degree cells covering 38–40° N and 123–120° W, January 2016 to December 2024. The replay uses gridMET weather through two days before the target and wildfire discovery labels from the USDA records. Calendar splits are 2016–20 for training, 2021–22 for validation, and 2023–24 for testing. |
| `ca_fire_discoveries_1992_2024.csv.gz` | 283,285 unique California-tagged records from the USDA Forest Service Fire Program Analysis Fire-Occurrence Database, seventh edition. The extract contains dates and point locations. Use a state boundary for statewide mapping because some tagged points fall outside California. |
| `norcal_gridmet_daily.csv.gz` | 315,648 daily rows for 96 Northern California sites from January 2016 through December 2024. The source is gridMET gridded surface meteorology. |

[USDA Forest Service fire records](https://www.fs.usda.gov/rds/archive/catalog/RDS-2013-0009.7) · [gridMET documentation](https://www.climatologylab.org/gridmet.html)

## Replay scores and monthly weather

The weather analogue estimates each cell's chance from similar historical weather and times of year in the same cell, with a smoothed seasonal estimate. **Location + month** uses that seasonal estimate alone. It uses each cell's historical discovery rate for the target calendar month, smoothed towards the regional rate for that month.

Monthly weather values are medians for the same cell and calendar month as the input weather date, computed on the 2016–20 training rows. The comparison covers maximum temperature, minimum relative humidity, wind speed and daily precipitation. [Monthly weather medians](data/typical-weather.json)

The random forest benchmark uses the same seven replay weather features, cell coordinates and a cyclic encoding of day of year. Its trees fit 2016–20 data. Candidate settings were selected by 2021 top-ten capture with average precision breaking ties. The selected model uses 64 trees and requires at least 40 samples per leaf. A logistic calibration fitted on 2022 adjusts the probability estimates before evaluation. The final metrics and calibration chart use 2023–24 only. Each plotted point compares mean predicted risk with observed report frequency for one score group. The chart uses quantiles to create up to ten groups per model. [Benchmark script](scripts/evaluate_challenger.py) · [Held-out metrics](data/metrics.json) · [Calibration chart](data/calibration.png)

## Forecast weather and a future photo model

The starter uses historical daily gridMET analyses. To evaluate a forecast using tomorrow's weather, join the later valid time to a model run that was already available at the forecast cutoff. NOAA's High-Resolution Rapid Refresh archive offers hourly runs on a roughly 3 km grid over the contiguous United States. The National Weather Service API provides live hourly forecasts. [NOAA HRRR](https://rapidrefresh.noaa.gov/hrrr/) · [Open HRRR forecast archive](https://registry.opendata.aws/noaa-hrrr-pds/) · [NWS API documentation](https://www.weather.gov/documentation/services-web-api)

Training and evaluating a model that learns from ground photos requires matched camera, weather, and discovery records across more view locations and seasons. Use photos captured by the forecast cutoff and keep whole sites and time periods together when splitting data. Compare against a weather-only baseline on the same held-out dates and locations, using the observed share of positive cell-days. PhenoCam provides site/date archives for vegetation imagery. ALERTCalifornia accepts research requests for historical wildfire camera footage. [PhenoCam collection](https://doi.org/10.3334/ORNLDAAC/2364) · [ALERTCalifornia archive access](https://alertcalifornia.org/faqs/)
