#!/usr/bin/env python3
"""Verify vertex parsing against known-good OBJ data."""

import UnityPy
import struct

env = UnityPy.load("/tmp/arow-extract/WebBuildMar27.data")

for obj in env.objects:
    if obj.type.name != "Mesh":
        continue
    try:
        data = obj.read()
    except:
        continue
    if data.m_Name != "UnifiedCMV2":
        continue

    vd = data.m_VertexData
    raw = bytes(vd.m_DataSize)
    stride = 48  # from channel analysis

    # Parse first 5 vertices and compare with OBJ
    expected = [
        (-0.000952225702, 0.0142385392, 0.00543662393),
        (-0.0, 0.025303632, -0.00778075028),
        (-0.0, 0.0143194813, 0.00543662393),
        (-0.00168983685, 0.0252413526, -0.00778075028),
        (-0.00188355113, 0.0141454889, 0.00543662393),
    ]

    print("Comparing parsed vertices with OBJ:")
    for i in range(5):
        off = i * stride
        x, y, z = struct.unpack_from("<fff", raw, off)
        ex, ey, ez = expected[i]
        match = abs(x-ex) < 1e-6 and abs(y-ey) < 1e-6 and abs(z-ez) < 1e-6
        print(f"  [{i}] parsed=({x:.10f}, {y:.10f}, {z:.10f})")
        print(f"       expect=({ex:.10f}, {ey:.10f}, {ez:.10f})")
        print(f"       MATCH={match}")

    # Check UV at channel 4 (offset=40)
    print("\nUV coordinates (channel 4, offset=40):")
    for i in range(5):
        off = i * stride + 40
        u, v = struct.unpack_from("<ff", raw, off)
        print(f"  [{i}] u={u:.6f}, v={v:.6f}")

    # Check submesh index ranges
    print("\nSubmesh index ranges:")
    idata = bytes(data.m_IndexBuffer)
    for si, sm in enumerate(data.m_SubMeshes):
        start_byte = sm.firstByte
        count = sm.indexCount
        first_vert = sm.firstVertex
        vert_count = sm.vertexCount

        # Read first few indices
        indices = []
        for j in range(min(6, count)):
            off = start_byte + j * 2
            idx = struct.unpack_from("<H", idata, off)[0]
            indices.append(idx)

        print(f"  sub[{si}]: firstByte={start_byte}, indexCount={count}, "
              f"firstVertex={first_vert}, vertexCount={vert_count}")
        print(f"    first indices: {indices}")

    # Now test using UnityPy's export to get the real data
    print("\n\nUsing mesh.export() to verify:")
    obj_text = data.export()
    lines = obj_text.strip().split("\n")
    
    verts = []
    normals = []
    uvs = []
    faces = []
    for line in lines:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v":
            verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif parts[0] == "vn":
            normals.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif parts[0] == "vt":
            uvs.append((float(parts[1]), float(parts[2])))
        elif parts[0] == "f":
            faces.append(parts[1:])

    print(f"  Vertices: {len(verts)}, Normals: {len(normals)}, UVs: {len(uvs)}, Faces: {len(faces)}")
    if uvs:
        print(f"  First 5 UVs: {uvs[:5]}")
    if verts:
        print(f"  First 5 verts: {verts[:5]}")

    break
