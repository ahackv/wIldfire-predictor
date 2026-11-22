# Wildfire Finder

Replay a next-day wildfire forecast for Northern California. Choose a sample or upload a photo, enter the scene coordinates and date, and run the replay. The map ranks 96 cells by estimated chance of a new wildfire discovery report on the next calendar day. Reveal the recorded outcome after the prediction.

## Run the demo

Serve this folder with `npm run dev` or `python -m http.server 3000`, then visit [localhost:3000](http://localhost:3000). The app uses plain HTML, CSS and JavaScript. Uploaded photos stay in the browser.

Select a capture date from **31 December 2022 to 30 December 2024**. The replay covers 38° to just under 40° N and −123° to just under −120° longitude. Photos show the scene during the replay. The model scores location, season and historical weather through two days before the target.

## Where the data are

- [`data/photo-weather-samples.csv`](data/photo-weather-samples.csv) pairs **62 PhenoCam photos** with the starter's weather and outcomes. There were no discovery reports on 23 target dates and at least one on eight dates. Both cameras are in the same cell.
- [`data/photos.json`](data/photos.json) describes the four bundled demo photos. PhenoCam Network imagery is credited under [CC BY 4.0](https://phenocam.nau.edu/webcam/fairuse_statement/).
- [`data/replay-2023.json`](data/replay-2023.json) and [`data/replay-2024.json`](data/replay-2024.json) contain the browser-ready scores, context weather and recorded outcomes.
- [`DATASETS.md`](DATASETS.md) lists the sources and what each file does. The full training data and 19-source catalogue are in the separate `Andrew_Wildfire_Hackathon_Starter.zip` attachment.

## Rebuild the replay

With Python 3 and the starter ZIP available, run:

```sh
python -m pip install numpy pandas scikit-learn threadpoolctl
python scripts/build_replay.py /path/to/Andrew_Wildfire_Hackathon_Starter.zip
```

The generator fits the weather analogue model using 2016–20. On the 731 replay days in 2023–24, its top ten daily cells capture **968 of 2,936** positive cell-days (33.0%). A place-and-month baseline captures **924** (31.5%). These are historical estimates for reports in this study grid. A model that learns from the photos would need a separate training and evaluation dataset spanning more sites and seasons.
