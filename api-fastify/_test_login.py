# -*- coding: utf-8 -*-
import urllib.request, json

body = json.dumps({"username": "demo", "password": "admin123456!@#"}).encode()
req = urllib.request.Request("http://127.0.0.1:8858/api/auth/login", data=body, headers={"Content-Type": "application/json"})
try:
    resp = urllib.request.urlopen(req, timeout=5)
    data = json.loads(resp.read())
    print("=== LOGIN SUCCESS ===")
    print("access_token:", data.get("access_token", "")[:50], "...")
    print("refresh_token:", data.get("refresh_token", "")[:50], "...")
    print("user:", json.dumps(data.get("user", {}), ensure_ascii=False))
    print()

    # 测试接口权限：用拿到的 token 访问 sqlite_demo
    token = data["access_token"]
    req2 = urllib.request.Request("http://127.0.0.1:8858/api/sqlite_demo/foose_product?page=1&pageSize=5", headers={"Authorization": "Bearer " + token})
    resp2 = urllib.request.urlopen(req2, timeout=5)
    data2 = json.loads(resp2.read())
    print("=== API CALL SUCCESS ===")
    print("meta:", json.dumps(data2.get("meta", {})))
    print("data[0]:", json.dumps(data2.get("data", [{}])[0], ensure_ascii=False) if data2.get("data") else "(空)")
except urllib.error.HTTPError as e:
    print("=== LOGIN/API FAILED: HTTP " + str(e.code) + " ===")
    print(e.read().decode())
except Exception as e:
    print("=== ERROR: " + str(e) + " ===")
