#!/usr/bin/env python3
"""Debug mesh extraction by comparing with known-good OBJ data."""

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

    print(f"Mesh: {data.m_Name}")
    print(f"  m_VertexCount: {getattr(data, 'm_VertexCount', 'N/A')}")
    print(f"  Mesh attrs: {[a for a in dir(data) if a.startswith('m_')]}")

    vd = data.m_VertexData
    print(f"  VertexData attributes:")
    print(f"    m_VertexCount: {vd.m_VertexCount}")

    if hasattr(vd, "m_Channels"):
        print(f"    Channels ({len(vd.m_Channels)}):")
        for i, ch in enumerate(vd.m_Channels):
            print(f"      [{i}] stream={ch.stream} offset={ch.offset} format={ch.format} dim={ch.dimension}")

    if hasattr(vd, "m_Streams") and vd.m_Streams:
        print(f"    Streams ({len(vd.m_Streams)}):")
        for i, st in enumerate(vd.m_Streams):
            attrs = {k: getattr(st, k) for k in dir(st) if not k.startswith("_")}
            print(f"      [{i}] {attrs}")

    # Get raw data
    raw = None
    if hasattr(vd, "m_DataSize") and vd.m_DataSize:
        raw = bytes(vd.m_DataSize)
    elif hasattr(vd, "data") and vd.data:
        raw = bytes(vd.data)

    if raw:
        print(f"    Raw data length: {len(raw)} bytes")
    else:
        print(f"    NO raw data!")

    # Try using UnityPy's built-in mesh export
    print(f"\n  Trying mesh.export()...")
    try:
        exported = data.export()
        if isinstance(exported, str):
            lines = exported.split("\n")[:30]
            print(f"    Got {len(exported)} chars, first lines:")
            for l in lines:
                print(f"      {l}")
        elif isinstance(exported, bytes):
            print(f"    Got {len(exported)} bytes")
        else:
            print(f"    Got type: {type(exported)}")
    except Exception as e:
        print(f"    Export failed: {e}")

    # Check submeshes
    print(f"\n  SubMeshes ({len(data.m_SubMeshes)}):")
    for i, sm in enumerate(data.m_SubMeshes):
        attrs = {}
        for k in dir(sm):
            if not k.startswith("_"):
                attrs[k] = getattr(sm, k)
        print(f"    [{i}] {attrs}")

    # Index buffer
    idata = bytes(data.m_IndexBuffer) if hasattr(data, "m_IndexBuffer") else None
    print(f"\n  Index buffer: {len(idata) if idata else 0} bytes")

    break
