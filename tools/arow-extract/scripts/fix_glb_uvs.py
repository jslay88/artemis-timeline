#!/usr/bin/env python3
"""
Fix UV coordinates in the Orion GLB.

Unity uses bottom-left UV origin (V increases upward).
glTF uses top-left UV origin (V increases downward).
The extraction didn't flip V, so all textures appear vertically flipped.

This script flips V (v = 1.0 - v) for every TEXCOORD_0 accessor,
and also extracts embedded textures for inspection.
"""
import json, struct, os

GLB_PATH = "/home/jslay/dev/artemis-timeline/public/models/orion.glb"
OUT_DIR = "/tmp/arow-extract/glb_textures"
os.makedirs(OUT_DIR, exist_ok=True)

with open(GLB_PATH, "rb") as f:
    magic, version, total_length = struct.unpack("<III", f.read(12))
    json_chunk_len, json_chunk_type = struct.unpack("<II", f.read(8))
    json_data = f.read(json_chunk_len)
    bin_chunk_len, bin_chunk_type = struct.unpack("<II", f.read(8))
    bin_data = bytearray(f.read(bin_chunk_len))

gltf = json.loads(json_data)

# ── Extract embedded textures for inspection ──
print("=== Extracting embedded textures ===")
for i, img in enumerate(gltf.get("images", [])):
    bv_idx = img.get("bufferView")
    if bv_idx is None:
        print(f"  [{i}] {img.get('name','?')} — no bufferView (external URI?)")
        continue
    bv = gltf["bufferViews"][bv_idx]
    offset = bv.get("byteOffset", 0)
    length = bv["byteLength"]
    mime = img.get("mimeType", "image/png")
    ext = "png" if "png" in mime else "jpg"
    name = img.get("name", f"image_{i}").replace(" ", "_")
    out_path = os.path.join(OUT_DIR, f"{i}_{name}.{ext}")
    with open(out_path, "wb") as out:
        out.write(bin_data[offset:offset+length])
    print(f"  [{i}] {name} → {out_path} ({length} bytes)")

# ── Collect all unique TEXCOORD_0 accessor indices ──
tc_accessors = set()
for mesh in gltf["meshes"]:
    for prim in mesh["primitives"]:
        tc_idx = prim["attributes"].get("TEXCOORD_0")
        if tc_idx is not None:
            tc_accessors.add(tc_idx)

print(f"\n=== Flipping V on {len(tc_accessors)} TEXCOORD_0 accessors ===")

for acc_idx in sorted(tc_accessors):
    acc = gltf["accessors"][acc_idx]
    bv_idx = acc["bufferView"]
    bv = gltf["bufferViews"][bv_idx]

    base_offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    byte_stride = bv.get("byteStride", 0)
    if byte_stride == 0:
        byte_stride = 8  # VEC2 of float32 = 2*4 = 8 bytes (tightly packed)
    count = acc["count"]

    flipped = 0
    for i in range(count):
        v_offset = base_offset + i * byte_stride + 4  # +4 bytes to skip U float
        v_val = struct.unpack_from("<f", bin_data, v_offset)[0]
        struct.pack_into("<f", bin_data, v_offset, 1.0 - v_val)
        flipped += 1

    print(f"  Accessor {acc_idx}: flipped {flipped} V coordinates (stride={byte_stride})")

# ── Write fixed GLB ──
json_str = json.dumps(gltf, separators=(',', ':'))
json_bytes = json_str.encode('utf-8')
padding = (4 - len(json_bytes) % 4) % 4
json_bytes += b' ' * padding

new_total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)

with open(GLB_PATH, "wb") as f:
    f.write(struct.pack("<III", 0x46546C67, 2, new_total))  # GLB header
    f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))  # JSON chunk
    f.write(json_bytes)
    f.write(struct.pack("<II", len(bin_data), 0x004E4942))  # BIN chunk
    f.write(bytes(bin_data))

print(f"\nFixed GLB written: {new_total:,} bytes → {GLB_PATH}")
