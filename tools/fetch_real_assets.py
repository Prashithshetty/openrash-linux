#!/usr/bin/env python3
"""
Fetch and verify 100% of the complete roadrash.fun asset manifest into www/
for offline native Linux execution.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE_URL = "https://roadrash.fun"
REPO_ROOT = Path(__file__).resolve().parent.parent
WWW_DIR = REPO_ROOT / "www"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"
}

COURSES = ["city", "hiway", "medly", "napa", "canyn"]
HORIZONS = ["city", "napa", "sierra", "pch", "penin"]
CHARS = ["axle", "bose", "cydney", "jon", "pearl", "rhonda", "jim", "mike"]
MOODS = ["n", "h", "f"]
BIKE_PICS = {
    "rat": ["banzai", "corsair", "kamikaze", "perro", "killer"],
    "sport": ["diablo", "kamikaze", "stiletto", "dmg", "perro"],
    "super": ["banzai", "diablo", "stiletto", "corsair", "kamikaze"],
}
SONGS = [
    "hb_trip", "hb_pass", "mm_dino", "p_pansy", "p_jessie", "p_bridge",
    "sg_rusty", "sg_outsh", "sg_kicks", "sg_super", "sd_train", "sd_duel",
    "t_teeth", "t_auto",
]
SFX_NAMES = sorted(set([
    # Menu & UI
    "bounce", "m_yeah",
    # Engines & Nitro
    "engrat", "engsport", "engsuper", "engnitro",
    # Crashes & Skids
    "crashlit", "crashmed", "crashhar", "skidonnr", "skidoffr",
    # Combat
    "swishcha", "swishgen", "chainimp", "clubimpa", "kick_mw4", "punchlig", "punchhea",
    "gruntm1_", "gruntm2_", "gruntm3_", "gruntm4_", "gruntm5_",
    # Police
    "siren", "sirenfst",
    # Pedestrian & Bar Voices
    "bkm1_hey", "bkm1_huh", "bkm2_hld",
    "bkw1_don", "bkw2_bit", "bkw3_stp",
    "bsm1_wat", "bsm2_woa", "bsm3_wha",
    "bsw1_no", "bsw2_aaa", "bsw3_hey",
    "ol_aaa", "ol_make",
    "sk1_dude", "sk1_eatt",
    "tour_aaa", "tour_bac",
    "jm_aiie", "jf_no",
    "fg1_watc", "fg2_eek",
    "cm1_heym", "cm3_arrg",
    "af1_eek", "hf_help",
    "dm_holys", "dm_usob",
]))


def download_one(rel_path: str, optional: bool = False):
    dest = WWW_DIR / rel_path
    if dest.exists() and dest.stat().st_size > 16:
        # Sanity check not HTML error page
        with open(dest, "rb") as f:
            head = f.read(64).lstrip().lower()
        if not head.startswith(b"<!doctype html") and not head.startswith(b"<html"):
            return rel_path, "cached", dest.stat().st_size

    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"{BASE_URL}/{rel_path}"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=45) as resp:
                data = resp.read()
                head = data[:64].lstrip().lower()
                if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
                    return rel_path, "opt-skip" if optional else "html-fallback", 0
                tmp = dest.with_suffix(dest.suffix + ".part")
                with open(tmp, "wb") as f:
                    f.write(data)
                tmp.replace(dest)
                return rel_path, "downloaded", len(data)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return rel_path, "opt-skip" if optional else "HTTP-404", 0
            if attempt == 2:
                return rel_path, f"HTTP-{e.code}", 0
            time.sleep(0.6 * (attempt + 1))
        except Exception as e:
            if attempt == 2:
                return rel_path, f"ERR-{e}", 0
            time.sleep(0.6 * (attempt + 1))
    return rel_path, "failed", 0


def read_json(rel_path: str):
    with open(WWW_DIR / rel_path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_manifest():
    # Step 1: Ensure all 102 JSON metadata files exist first
    json_files = [
        "assets/text.json",
        "data/bikes.json",
        "data/rider-rects.json",
        "data/shadow-rects.json",
        "data/cop-rects.json",
        "data/cars.json",
        "data/peds.json",
    ]
    for c in COURSES:
        json_files.extend([
            f"data/{c}.json",
            f"data/{c}-sections.json",
            f"data/{c}-lanes.json",
            f"data/{c}-lanes-forks.json",
            f"data/{c}-shoulder.json",
            f"data/{c}-shoulder-forks.json",
            f"data/{c}-rails.json",
            f"data/{c}-rails-forks.json",
            f"data/{c}-verge.json",
            f"data/{c}-hills.json",
            f"data/{c}-tunnels.json",
            f"data/{c}-mtn.json",
            f"data/{c}-scenery.json",
            f"data/{c}-props.json",
            f"data/{c}-props-forks.json",
            f"data/{c}-road.json",
            f"data/{c}-hazards.json",
            f"data/{c}-hazards-forks.json",
            f"data/atlas/{c}.json",
        ])

    with ThreadPoolExecutor(max_workers=16) as ex:
        for rel, st, _ in ex.map(download_one, json_files):
            if st not in ("cached", "downloaded"):
                raise RuntimeError(f"Required JSON failed: {rel} ({st})")

    # Step 2: Derive dynamic texture, atlas, car, and ped lists from JSONs
    tex_names = set([
        "START160", "FINISH", "STOP3E", "STOP3G", "STOP3Y", "STOP3R",
        "SCTSIDWK", "SAND", "WHITE", "YELLOW", "PLAIN", "SANDL", "SANDLX",
        "WATER128", "SEA128", "HILL12A", "HILL13A", "CLIFF3A", "RRRAIL1",
    ])
    atlas_bases = []
    car_names = set()
    ped_names = set()

    cars = read_json("data/cars.json")
    for obj in cars.values():
        for kind in obj.get("moving", []) + obj.get("parked", []):
            car_names.add(kind["name"])

    peds = read_json("data/peds.json")
    ped_names.update(peds.keys())

    for c in COURSES:
        atlas = read_json(f"data/atlas/{c}.json")
        atlas_rects = set(atlas.get("rects", {}).keys())
        for p in range(atlas.get("pages", 0)):
            atlas_bases.append(f"data/atlas/{c}-{p}")

        verge = read_json(f"data/{c}-verge.json")
        if isinstance(verge, list):
            for side in verge[:2]:
                if isinstance(side, list):
                    for run in side:
                        if len(run) > 1 and run[1]:
                            tex_names.add(run[1])
            if len(verge) > 2 and isinstance(verge[2], list):
                for fork_runs in verge[2]:
                    for run in (fork_runs or []):
                        if len(run) > 1 and run[1]:
                            tex_names.add(run[1])

        for rec in read_json(f"data/{c}-hills.json"):
            if len(rec) > 4 and rec[4]:
                for side_st in rec[4]:
                    for name in (side_st or []):
                        if name:
                            tex_names.add(name)

        for rec in read_json(f"data/{c}-rails.json"):
            for idx in (3, 4):
                if len(rec) > idx and rec[idx]:
                    tex_names.add(rec[idx])
        for fork_list in read_json(f"data/{c}-rails-forks.json"):
            for rec in (fork_list or []):
                for idx in (3, 4):
                    if len(rec) > idx and rec[idx]:
                        tex_names.add(rec[idx])

        for rec in read_json(f"data/{c}-tunnels.json"):
            if len(rec) > 2 and isinstance(rec[2], list):
                for name in rec[2]:
                    if isinstance(name, str) and name:
                        tex_names.add(name)

        for rec in read_json(f"data/{c}-mtn.json"):
            if len(rec) > 4 and rec[4]:
                for side_faces in rec[4]:
                    for name in (side_faces or []):
                        if isinstance(name, str) and name:
                            tex_names.add(name)

        scen = read_json(f"data/{c}-scenery.json")
        if isinstance(scen, dict):
            for fam in scen.get("fams", {}).values():
                for obj in (fam or []):
                    if isinstance(obj, list) and obj and obj[0] and obj[0] not in atlas_rects:
                        tex_names.add(obj[0])

        for pr in read_json(f"data/{c}-props.json"):
            name, frames = pr[2], (pr[7] if len(pr) > 7 else None)
            if frames and isinstance(frames, list):
                tex_names.update(f for f in frames if f)
            elif name and name not in atlas_rects:
                tex_names.add(name)
        for fork_list in read_json(f"data/{c}-props-forks.json"):
            for pr in (fork_list or []):
                name, frames = pr[2], (pr[7] if len(pr) > 7 else None)
                if frames and isinstance(frames, list):
                    tex_names.update(f for f in frames if f)
                elif name and name not in atlas_rects:
                    tex_names.add(name)

        for o in read_json(f"data/{c}-road.json"):
            t = o.get("t")
            if t and t not in atlas_rects:
                tex_names.add(t)

    required = []
    optional = []

    # Step 3: Icons & Fonts
    required.extend([
        "assets/favicon.svg",
        "assets/icon-180.png",
        "assets/icon-192.png",
        "assets/icon-512.png",
        "assets/icon-maskable-512.png",
        "assets/fonts/FUTB.ttf",
        "assets/fonts/FUTD.ttf",
        "assets/fonts/FUTR.ttf",
    ])

    # Step 4: Data textures/sprites (.webp primary + .png fallback)
    data_image_bases = list(atlas_bases)
    data_image_bases.extend(["data/cop", "data/shadow"])
    for i in range(15):
        data_image_bases.append(f"data/rider{i}")
    for h in HORIZONS:
        data_image_bases.append(f"data/horizon-{h}")
    for t in sorted(tex_names):
        data_image_bases.append(f"data/tex/{t}")
    for car in sorted(car_names):
        data_image_bases.append(f"data/cars/{car}")
    for ped in sorted(ped_names):
        data_image_bases.append(f"data/peds/{ped}")

    for base in data_image_bases:
        required.append(f"{base}.png")
        optional.append(f"{base}.webp")
    optional.extend(["data/rider15.png", "data/rider15.webp"])

    # Step 5: Dashboards & Menu/UI Artwork
    required.extend([
        "assets/img/dash/bigmeter.png",
        "assets/img/dash/rat.png",
        "assets/img/dash/sport.png",
        "assets/img/dash/super.png",
        "assets/img/splash.jpg",
        "assets/img/credits.jpg",
        "assets/img/street.jpg",
        "assets/img/olleys.jpg",
        "assets/img/postcard.jpg",
    ])
    for card in [
        "city", "sierra", "penin", "napa", "pch",
        "qcity", "qsierra", "qpenin", "qnapa", "qpch",
        "klub", "resta",
    ]:
        required.append(f"assets/img/postcard/{card}.jpg")

    for ch in CHARS:
        for m in MOODS:
            required.append(f"assets/img/chars/{ch}-{m}.jpg")

    for cls, pics in BIKE_PICS.items():
        required.append(f"assets/img/showroom/{cls}/bikes.jpg")
        for pic in pics:
            required.append(f"assets/img/showroom/{cls}/{pic}.jpg")
            required.append(f"assets/img/bikes/{cls}/{pic}.jpg")
            required.append(f"assets/video/{cls}/{pic}.mp4")

    for i in range(1, 7):
        required.append(f"assets/img/restroom/rest{i}.jpg")
        required.append(f"assets/img/results/win{i}.jpg")
        required.append(f"assets/img/results/lose{i}.jpg")
        required.append(f"assets/img/results/wreck{i}.jpg")
        required.append(f"assets/img/results/bust{i}.jpg")
    for i in range(1, 5):
        required.append(f"assets/img/results/level{i}.jpg")
    for i in range(7, 11):
        optional.append(f"assets/img/results/lose{i}.jpg")

    # Step 6: Audio (SFX + Music)
    for sfx in SFX_NAMES:
        required.append(f"assets/sfx/{sfx}.wav")
    for song in SONGS:
        required.append(f"assets/music/{song}.ogg")
        required.append(f"assets/music/{song}.m4a")

    # Step 7: Cutscene & Music Videos
    required.extend(["assets/video/jessie.mp4", "assets/video/duel.mp4", "assets/video/finalwin.mp4"])
    for i in range(1, 7):
        required.append(f"assets/video/start{i}.mp4")
        required.append(f"assets/video/win{i}.mp4")
        required.append(f"assets/video/wreck{i}.mp4")
        required.append(f"assets/video/busted{i}.mp4")
    for i in range(1, 11):
        required.append(f"assets/video/lose{i}.mp4")
    for i in range(1, 5):
        required.append(f"assets/video/level{i}.mp4")

    return required, optional


def main():
    print(f"Building complete roadrash.fun asset manifest into {WWW_DIR} ...")
    required, optional = build_manifest()
    print(f"Required files: {len(required)}, Optional/WebP variants: {len(optional)}")

    tasks = [(p, False) for p in required] + [(p, True) for p in optional]
    downloaded = 0
    cached = 0
    opt_skipped = 0
    failures = []
    total_bytes = 0

    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = {ex.submit(download_one, p, opt): (p, opt) for p, opt in tasks}
        done_cnt = 0
        for fut in as_completed(futs):
            done_cnt += 1
            rel, st, sz = fut.result()
            total_bytes += sz
            if st == "downloaded":
                downloaded += 1
            elif st == "cached":
                cached += 1
            elif st == "opt-skip":
                opt_skipped += 1
            else:
                failures.append((rel, st))
            if done_cnt % 100 == 0 or done_cnt == len(tasks):
                print(
                    f"  Progress: {done_cnt}/{len(tasks)} "
                    f"(downloaded={downloaded}, cached={cached}, opt_skip={opt_skipped}, fail={len(failures)})",
                    flush=True,
                )

    print(
        f"\nAsset sync complete: downloaded={downloaded}, cached={cached}, "
        f"opt_skip={opt_skipped}, total_payload={total_bytes / (1024 * 1024):.1f} MiB"
    )
    if failures:
        print(f"ERROR: {len(failures)} required asset(s) failed:")
        for rel, st in failures:
            print(f"  - {rel}: {st}")
        sys.exit(1)


if __name__ == "__main__":
    main()
