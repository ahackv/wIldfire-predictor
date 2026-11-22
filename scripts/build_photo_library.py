"""Build the historical photo picker from public PhenoCam month indexes."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen


BASE_URL = "https://phenocam.nau.edu"
CREDIT = "PhenoCam Network, CC BY 4.0"
SITES = {
    "tonzi": ("Tonzi Ranch", ("2023/07", "2024/03", "2024/09")),
    "vaira": ("Vaira Ranch", ("2023/07", "2024/09")),
    "sagehen": ("Sagehen Creek", ("2023/06", "2023/07", "2024/09")),
    "hillslough": ("Hill Slough", ("2023/07", "2024/09")),
    "bouldincorn": ("Bouldin Island", ("2023/07", "2024/09")),
}


def get(path):
    request = Request(BASE_URL + path, headers={"User-Agent": "Wildfire Finder photo catalogue"})
    with urlopen(request, timeout=12) as response:
        return response.read().decode("utf-8")


def site_location(site):
    metadata = json.loads(get(f"/api/cameras/{site}/"))
    latitude = float(metadata["Lat"])
    longitude = float(metadata["Lon"])
    if not (38 <= latitude < 40 and -123 <= longitude < -120):
        raise ValueError(f"{site} falls outside the wildfire replay grid.")
    cell = int((latitude - 38) / 0.25) * 12 + int((longitude + 123) / 0.25)
    return latitude, longitude, cell


def monthly_photos(site, month, location):
    html = get(f"/webcam/browse/{site}/{month}/")
    year, month_number = month.split("/")
    filename_prefix = f"{site}_{year}_{month_number}_"
    filenames = re.findall(
        rf'src="/data/thumbnails/{site}/{month}/({filename_prefix}(\d{{2}})_\d{{6}}\.jpg)"',
        html,
    )
    site_name = SITES[site][0]
    latitude, longitude, cell = location
    for filename, day in filenames:
        capture = date(int(year), int(month_number), int(day))
        month_name = capture.strftime("%B")
        yield {
            "id": f"{site}-{capture.isoformat()}",
            "label": f"{site_name} · {capture.day} {month_name} {capture.year}",
            "site": site_name,
            "url": f"{BASE_URL}/data/archive/{site}/{month}/{filename}",
            "thumbnail": f"{BASE_URL}/data/thumbnails/{site}/{month}/{filename}",
            "credit": CREDIT,
            "source": f"{BASE_URL}/webcam/browse/{site}/{month}/{day}/",
            "photoDate": capture.isoformat(),
            "lat": latitude,
            "lon": longitude,
        }, (capture + timedelta(days=1)).isoformat(), cell


def build(data):
    replay = {}
    for year in (2023, 2024):
        replay.update(json.loads((data / f"replay-{year}.json").read_text(encoding="utf-8")))
    photos = []
    matched = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        locations = dict(zip(SITES, pool.map(site_location, SITES)))
        months = [(site, month, locations[site]) for site, (_, values) in SITES.items() for month in values]
        archive_requests = pool.map(lambda args: list(monthly_photos(*args)), months)
        for entries in archive_requests:
            for photo, target, cell in entries:
                count = replay.get(target, {}).get("n", [])
                if len(count) != 96:
                    raise ValueError(f"{photo['id']} cannot be matched to a 96-cell replay day.")
                matched[target, cell] = count[cell] > 0
                photos.append(photo)
    if len(photos) < 300 or len({photo["id"] for photo in photos}) != len(photos):
        raise ValueError("The archive selection must have at least 300 uniquely dated site photos.")
    if set(matched.values()) != {False, True}:
        raise ValueError("The catalogue must include dates with and without reported discoveries.")
    photos.sort(key=lambda photo: (photo["site"], photo["photoDate"]))
    return photos, matched


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data"), help="Directory with replay data and output")
    args = parser.parse_args()
    photos, matched = build(args.data)
    output = args.data / "photo-library.json"
    output.write_text(json.dumps(photos, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    positives = sum(matched.values())
    print(f"{output} · {len(photos)} photos · {len(matched)} unique cell-days · {positives} with reports")


if __name__ == "__main__":
    main()
