#!/usr/bin/env python3
"""Debug: check the vertex data type and verify we can read vertices correctly."""

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

    # Check m_DataSize type
    print(f"type(vd.m_DataSize) = {type(vd.m_DataSize)}")
    if isinstance(vd.m_DataSize, (bytes, bytearray)):
        print(f"  It IS bytes, len = {len(vd.m_DataSize)}")
        raw = bytes(vd.m_DataSize)
    elif isinstance(vd.m_DataSize, int):
        print(f"  It's an INT = {vd.m_DataSize}")
        print(f"  This was the bug! bytes(int) creates zero-filled buffer!")

    # Check if data attribute exists
    if hasattr(vd, "data"):
        print(f"type(vd.data) = {type(vd.data)}")
        if isinstance(vd.data, (bytes, bytearray)):
            print(f"  vd.data len = {len(vd.data)}")
        elif isinstance(vd.data, int):
            print(f"  vd.data = {vd.data}")

    # Check all attributes of VertexData
    print(f"\nVertexData attributes: {[a for a in dir(vd) if not a.startswith('__')]}")

    # Try to get actual vertex data
    raw = None
    # Method 1: check if there's a byte buffer directly
    for attr in dir(vd):
        if attr.startswith("_"):
            continue
        val = getattr(vd, attr)
        if isinstance(val, (bytes, bytearray)) and len(val) > 100:
            print(f"\n  Found bytes in vd.{attr}: len={len(val)}")
            raw = bytes(val)

    # Method 2: try mesh.export() and parse OBJ
    # UnityPy's export() works, so its internal vertex parsing is correct
    # Let's use the mesh vertices/normals/uvs directly
    if hasattr(data, "m_Vertices") and data.m_Vertices:
        verts = data.m_Vertices
        print(f"\n  m_Vertices type={type(verts)}, len={len(verts) if hasattr(verts, '__len__') else '?'}")
        if isinstance(verts, (list, tuple)) and len(verts) >= 6:
            print(f"  First 2 vertices: {verts[:6]}")
    
    if hasattr(data, "m_Normals") and data.m_Normals:
        norms = data.m_Normals
        print(f"  m_Normals type={type(norms)}, len={len(norms) if hasattr(norms, '__len__') else '?'}")
    
    if hasattr(data, "m_UV") and data.m_UV:
        uvs = data.m_UV
        print(f"  m_UV type={type(uvs)}, len={len(uvs) if hasattr(uvs, '__len__') else '?'}")
        if isinstance(uvs, (list, tuple)) and len(uvs) >= 4:
            print(f"  First 2 UVs: {uvs[:4]}")

    if hasattr(data, "m_Tangents") and data.m_Tangents:
        tans = data.m_Tangents
        print(f"  m_Tangents type={type(tans)}, len={len(tans) if hasattr(tans, '__len__') else '?'}")

    break
