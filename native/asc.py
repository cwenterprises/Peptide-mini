#!/usr/bin/env python3
"""Minimal App Store Connect API client for PeptideOS (app id 6791469036).

Auth: PyJWT ES256, aud "appstoreconnect-v1". Key/issuer are the CW ASC API key.
Usage:
  python3 asc.py get   /v1/apps/6791469036/appInfos
  python3 asc.py patch /v1/appInfoLocalizations/<id> '{"privacyPolicyUrl":"..."}' appInfoLocalizations
  python3 asc.py post  /v1/betaGroups/<gid>/relationships/builds '{"data":[{"type":"builds","id":"<bid>"}]}' --raw
"""
import jwt, time, json, sys, urllib.request, urllib.error

KEY_ID = "BVTN73RR5Q"
ISSUER = "69a6de8e-3cf1-47e3-e053-5b8c7c11a4d1"
KEY_PATH = "/Users/coreywashington/Downloads/AuthKey_BVTN73RR5Q.p8"
APP_ID = "6791469036"
BASE = "https://api.appstoreconnect.apple.com"


def token():
    key = open(KEY_PATH).read()
    return jwt.encode(
        {"iss": ISSUER, "iat": int(time.time()), "exp": int(time.time()) + 900,
         "aud": "appstoreconnect-v1"},
        key, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Authorization": "Bearer " + token(),
                 "Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req)
        raw = r.read().decode()
        return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {"raw": txt[:600]}


if __name__ == "__main__":
    method = sys.argv[1].upper()
    path = sys.argv[2]
    raw_mode = "--raw" in sys.argv
    body = None
    # For PATCH/POST: python3 asc.py patch <path> '<attrsJson>' <resourceType> [<id>]
    if method in ("PATCH", "POST") and len(sys.argv) > 3 and not sys.argv[3].startswith("--"):
        payload = sys.argv[3]
        if raw_mode:
            body = json.loads(payload)
        else:
            rtype = sys.argv[4]
            rid = sys.argv[5] if len(sys.argv) > 5 else path.rstrip("/").split("/")[-1]
            body = {"data": {"type": rtype, "id": rid,
                             "attributes": json.loads(payload)}}
    status, resp = call(method, path, body)
    print("HTTP", status)
    print(json.dumps(resp, indent=2)[:4000])
