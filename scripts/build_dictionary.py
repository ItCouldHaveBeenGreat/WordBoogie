"""Reproduce the bundled SCOWL list from a checksum-verified official source archive.

Requires Python 3.11+ for maintenance only. Normal gameplay uses committed text data.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = "rel-2026.02.25"
COMMIT = "7e99edab8e32f9f9ea2b15f249ca8d4d67237410"
ARCHIVE_SHA256 = "98c973dd3326bbc7aa3373a7e6460065d04ed1f9a57b66dc362f80298fbf6fec"
SOURCE_URL = "https://codeload.github.com/en-wl/wordlist/zip/refs/tags/" + RELEASE
VERSION = "scowl-2026.02.25-en-US-60-v1"
FILTERS = ["word-list", "60", "A", "1", "--categories=", "--wo-poses=abbr,x",
           "--wo-pos-categories=nonword,wordpart",
           "--wo-pos-classes=person,surname,place,name,demonym,trademark,upper,name?,upper?,abbr,abbr?",
           "--no-word-filter", "--deaccent"]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def build(source):
    database = source / "scowl.db"
    if not database.exists():
        subprocess.run([sys.executable, "-X", "utf8", "combine.py", "create-db", "scowl.db"], cwd=source, check=True)
    result = subprocess.run([sys.executable, "-X", "utf8", "-m", "libscowl", *FILTERS],
                            cwd=source, check=True, capture_output=True, encoding="utf-8")
    # Case filtering happens BEFORE uppercasing, preserving upstream name/case distinctions.
    words = sorted({word.upper() for word in result.stdout.splitlines() if re.fullmatch(r"[a-z]{2,49}", word)})
    if len(words) < 30000 or not {"HARSH", "HARSHEST", "QUARTZ", "ELEPHANT"}.issubset(words):
        raise ValueError("Unexpected dictionary contents; refusing to overwrite the shipped list")
    data = ("\n".join(words) + "\n").encode("ascii")
    output = ROOT / "packages" / "engine" / "data"
    output.mkdir(parents=True, exist_ok=True)
    (output / "scowl-en-US-60.txt").write_bytes(data)
    copyright_bytes = (source / "Copyright").read_bytes()
    (output / "SCOWL-Copyright.txt").write_bytes(copyright_bytes)
    (ROOT / "apps" / "web" / "dictionary-license.txt").write_bytes(copyright_bytes)
    metadata = {"dictionaryVersion": VERSION, "project": "SCOWL (en-wl/wordlist)",
                "release": RELEASE, "commit": COMMIT, "sourceArchive": SOURCE_URL,
                "sourceArchiveSha256": ARCHIVE_SHA256, "extractionArguments": FILTERS,
                "postFilter": "ASCII lowercase [a-z]{2,49} before uppercase; sorted unique; LF line endings",
                "wordCount": len(words), "sha256": digest(data), "copyrightSha256": digest(copyright_bytes)}
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(metadata, indent=2))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_archive", type=Path, help="Official release ZIP downloaded from the documented sourceArchive URL")
    parser.add_argument("--source-dir", type=Path, help="Optional existing extracted source with a built DB; source files are verified against ZIP")
    args = parser.parse_args()
    archive = args.source_archive.read_bytes()
    if digest(archive) != ARCHIVE_SHA256:
        raise ValueError("SCOWL archive checksum mismatch")
    with zipfile.ZipFile(args.source_archive) as zipped:
        entries = zipped.infolist()
        if any(Path(entry.filename).is_absolute() or ".." in Path(entry.filename).parts for entry in entries):
            raise ValueError("Unsafe source archive path")
        top = entries[0].filename.split("/")[0]
        if args.source_dir:
            source = args.source_dir.resolve()
            for entry in entries:
                if not entry.is_dir():
                    local = source.joinpath(*Path(entry.filename).parts[1:])
                    if local.read_bytes() != zipped.read(entry):
                        raise ValueError("Extracted source differs from verified archive: " + str(local))
            build(source)
        else:
            scratch = ROOT / ".local"
            scratch.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="scowl-build-", dir=scratch) as temporary:
                zipped.extractall(temporary)
                build(Path(temporary) / top)

if __name__ == "__main__":
    main()
