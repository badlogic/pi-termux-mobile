#!/usr/bin/env python3
"""Bundle current aarch64 Termux packages without executing maintainer scripts."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request

BASE = "https://packages.termux.dev/apt/termux-main/"
PREFIX = "/data/data/com.termux/files/usr"
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "android/app/src/main/assets"


def download(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def main():
    index = gzip.decompress(download(BASE + "dists/stable/main/binary-aarch64/Packages.gz"))
    packages = {}
    for paragraph in index.decode().split("\n\n"):
        fields = {}
        for line in paragraph.splitlines():
            if line and not line[0].isspace() and ": " in line:
                key, value = line.split(": ", 1)
                fields[key] = value
        if "Package" in fields:
            packages[fields["Package"]] = fields

    selected = {}

    def resolve(expression):
        for alternative in expression.split("|"):
            match = re.fullmatch(r"\s*([\w+.-]+)(?::\w+)?(?:\s*\((<<|<=|=|>=|>>)\s*([^\)]+)\))?\s*", alternative)
            if not match:
                raise RuntimeError(f"Unsupported dependency: {expression}")
            name, operator, version = match.groups()
            package = packages.get(name)
            if package is None:
                continue
            if operator and subprocess.run(["dpkg", "--compare-versions", package["Version"], operator, version]).returncode:
                continue
            if name in selected:
                return
            selected[name] = package
            for field in ("Pre-Depends", "Depends"):
                for dependency in package.get(field, "").split(","):
                    if dependency.strip():
                        resolve(dependency)
            return
        raise RuntimeError(f"No package satisfies: {expression}")

    for name in ("nodejs", "npm", "bash", "coreutils", "git", "ripgrep", "fd", "openssh", "util-linux", "debianutils", "ca-certificates"):
        resolve(name)

    ASSETS.mkdir(parents=True, exist_ok=True)
    manifest = []
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        extracted = work / "rootfs"
        extracted.mkdir()
        for name, package in sorted(selected.items()):
            print(f"Downloading {name} {package['Version']}", flush=True)
            data = download(BASE + package["Filename"])
            digest = hashlib.sha256(data).hexdigest()
            if digest != package["SHA256"]:
                raise RuntimeError(f"Checksum mismatch: {name}")
            deb = work / f"{name}.deb"
            deb.write_bytes(data)
            subprocess.run(["dpkg-deb", "--extract", str(deb), str(extracted)], check=True)
            manifest.append({"package": name, "version": package["Version"], "sha256": digest, "filename": package["Filename"]})
        usr = extracted / PREFIX.lstrip("/")
        for path in usr.rglob("*"):
            if path.is_symlink():
                target = os.readlink(path)
                if target.startswith(PREFIX + "/"):
                    relative = os.path.relpath(usr / target[len(PREFIX) + 1:], path.parent)
                    path.unlink()
                    path.symlink_to(relative)
        for binary in ("node", "bash", "git", "rg", "fd", "ssh", "script"):
            if not (usr / "bin" / binary).is_file():
                raise RuntimeError(f"Missing runtime binary: {binary}")
        if not (usr / "etc/tls/cert.pem").is_file():
            raise RuntimeError("Missing CA certificate bundle")
        subprocess.run(["tar", "czf", str(ASSETS / "rootfs.bin"), "-C", str(usr.parent), "usr"], check=True)
    (ASSETS / "termux-packages.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
