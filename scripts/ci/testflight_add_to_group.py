#!/usr/bin/env python3
"""Wait for an uploaded build to finish processing, then add it to a TestFlight beta group.

Used by .github/workflows/ios-testflight.yml. Auth: App Store Connect API key from env
(ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 = the .p8 file contents).

  python3 testflight_add_to_group.py --app 6791469036 --build 21 --group Internal
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt

BASE = "https://api.appstoreconnect.apple.com"


def token():
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        os.environ["ASC_KEY_P8"],
        algorithm="ES256",
        headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"},
    )


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:500]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True)
    ap.add_argument("--build", required=True)
    ap.add_argument("--group", required=True)
    ap.add_argument("--timeout", type=int, default=40 * 60)
    a = ap.parse_args()

    # /v1/apps/{id}/betaGroups rejects filter[name]; the top-level collection accepts both filters
    q = urllib.parse.urlencode({"filter[app]": a.app, "filter[name]": a.group, "limit": 5})
    st, r = call("GET", f"/v1/betaGroups?{q}")
    groups = [g for g in r.get("data", []) if g["attributes"]["name"] == a.group]
    if st != 200 or not groups:
        sys.exit(f"beta group {a.group!r} not found ({st}): {r}")
    group_id = groups[0]["id"]

    deadline = time.time() + a.timeout
    q = urllib.parse.urlencode({"filter[app]": a.app, "filter[version]": a.build, "limit": 5})
    while True:
        st, r = call("GET", f"/v1/builds?{q}")
        builds = r.get("data", [])
        state = builds[0]["attributes"]["processingState"] if builds else "NOT_FOUND_YET"
        print(f"build {a.build}: {state}", flush=True)
        if state == "VALID":
            break
        if state in ("FAILED", "INVALID"):
            sys.exit(f"build {a.build} processing {state}")
        if time.time() > deadline:
            sys.exit(f"timed out waiting for build {a.build} to process (last state {state})")
        time.sleep(30)

    build_id = builds[0]["id"]
    st, r = call("POST", f"/v1/betaGroups/{group_id}/relationships/builds",
                 {"data": [{"type": "builds", "id": build_id}]})
    if st not in (200, 204):
        sys.exit(f"adding build to {a.group!r} failed ({st}): {r}")
    print(f"build {a.build} added to TestFlight group {a.group!r}")


if __name__ == "__main__":
    main()
