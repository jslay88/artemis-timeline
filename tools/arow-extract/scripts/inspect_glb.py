#!/usr/bin/env python3
"""Inspect the current working GLB to understand its material/texture structure."""
import json, struct

path = "/home/jslay/dev/artemis-timeline/public/models/orion.glb"
with open(path, "rb") as f:
    magic, version, length = struct.unpack("<III", f.read(12))
    json_len, json_type = struct.unpack("<II", f.read(8))
    json_bytes = f.read(json_len)

gltf = json.loads(json_bytes)

print("=== MESHES ===")
for i, m in enumerate(gltf.get("meshes", [])):
    print(f"  [{i}] {m.get('name', '?')}: {len(m.get('primitives', []))} primitives")
    for j, p in enumerate(m.get("primitives", [])):
        mat_idx = p.get("material", -1)
        attrs = list(p.get("attributes", {}).keys())
        idx_acc = p.get("indices", -1)
        print(f"    prim[{j}]: material={mat_idx}, attrs={attrs}")

print("\n=== MATERIALS ===")
for i, m in enumerate(gltf.get("materials", [])):
    pbr = m.get("pbrMetallicRoughness", {})
    tex = pbr.get("baseColorTexture", {}).get("index", -1)
    color = pbr.get("baseColorFactor", None)
    print(f"  [{i}] {m.get('name', '?')}: texture={tex}, color={color}")

print("\n=== TEXTURES ===")
for i, t in enumerate(gltf.get("textures", [])):
    src = t.get("source", -1)
    print(f"  [{i}] source_image={src}")

print("\n=== IMAGES ===")
for i, img in enumerate(gltf.get("images", [])):
    print(f"  [{i}] {img.get('name', '?')} mime={img.get('mimeType', '?')}")

print("\n=== NODES ===")
for i, n in enumerate(gltf.get("nodes", [])):
    print(f"  [{i}] {n.get('name', '?')} mesh={n.get('mesh', '-')}")
