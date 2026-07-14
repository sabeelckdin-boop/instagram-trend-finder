#!/usr/bin/env python3
"""
shazam_recognize.py — Production Shazam audio recognition via ShazamIO.
Called by Node.js via child_process.execFile().

Usage:
    python shazam_recognize.py /path/to/audio.mp3

Output (stdout, JSON):
    On success:
        {"success":true,"shazamTrackId":"880744620","isrc":"INT202606950",
         "title":"Aathi Raasathi","artist":"Sai Abhyankkar",
         "album":"Karuppu (Original Motion Picture Soundtrack)"}
    On failure:
        {"success":false,"error":"description"}
"""

import asyncio
import json
import os
import sys

from shazamio import Shazam


async def recognize(audio_path: str) -> dict:
    if not os.path.isfile(audio_path):
        return {"success": False, "error": f"File not found: {audio_path}"}

    try:
        shazam = Shazam()
        raw = await shazam.recognize(audio_path)
    except Exception as e:
        return {"success": False, "error": f"ShazamIO error: {str(e)}"}

    if not raw or not isinstance(raw, dict):
        return {"success": False, "error": "Empty or invalid response from Shazam"}

    track = raw.get("track")
    if not track:
        return {"success": False, "error": "No track found (unrecognized audio)"}

    shazam_track_id = str(track.get("key", ""))
    title = track.get("title", "")
    artist = track.get("subtitle", "")
    isrc = track.get("isrc", "")

    album = ""
    sections = track.get("sections", [])
    if sections:
        for section in sections:
            if section.get("type") == "SONG":
                metadata = section.get("metadata", [])
                for meta in metadata:
                    if meta.get("title") == "Album":
                        album = meta.get("text", "")
                        break

    if not shazam_track_id:
        return {"success": False, "error": "No track key in Shazam response"}

    return {
        "success": True,
        "shazamTrackId": shazam_track_id,
        "isrc": isrc or "",
        "title": title or "",
        "artist": artist or "",
        "album": album or "",
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: shazam_recognize.py <audio_file_path>"}))
        sys.exit(0)
    result = asyncio.run(recognize(sys.argv[1]))
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()