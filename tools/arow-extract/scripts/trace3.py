#!/usr/bin/env python3
"""Debug: print ALL mesh filters with their vert counts."""

import UnityPy

env = UnityPy.load("/tmp/arow-extract/WebBuildMar27.data")

meshes = {}
go_names = {}
mesh_filters = {}

for obj in env.objects:
    t = obj.type.name
    try:
        data = obj.read()
    except Exception:
        continue

    if t == "GameObject":
        go_names[obj.path_id] = data.m_Name
    elif t == "Mesh":
        meshes[obj.path_id] = {
            "name": data.m_Name,
            "verts": getattr(data, "m_VertexCount", 0),
            "subs": len(data.m_SubMeshes) if hasattr(data, "m_SubMeshes") else 0
        }
    elif t == "MeshFilter":
        go_pid = getattr(getattr(data, "m_GameObject", None), "path_id", 0)
        mesh_pid = 0
        if hasattr(data, "m_Mesh") and data.m_Mesh:
            mesh_pid = getattr(data.m_Mesh, "path_id", 0)
        if go_pid:
            mesh_filters[go_pid] = mesh_pid

print(f"Total MeshFilters: {len(mesh_filters)}")
print(f"Total Meshes with >0 verts: {sum(1 for m in meshes.values() if m['verts'] > 0)}")

print("\nAll GameObjects with MeshFilter:")
for go_pid, mesh_pid in sorted(mesh_filters.items(), key=lambda x: go_names.get(x[0], "")):
    go_name = go_names.get(go_pid, f"[unknown:{go_pid}]")
    mi = meshes.get(mesh_pid, None)
    if mi:
        print(f"  {go_name:40s} mesh={mi['name']:30s} verts={mi['verts']:6d} subs={mi['subs']}")
    else:
        print(f"  {go_name:40s} mesh_pid={mesh_pid} (NOT FOUND in meshes dict)")
