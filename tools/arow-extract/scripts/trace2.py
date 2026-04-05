#!/usr/bin/env python3
"""Faster approach: index everything first, then cross-reference."""

import UnityPy

env = UnityPy.load("/tmp/arow-extract/WebBuildMar27.data")

meshes = {}
materials = {}
textures = {}
go_names = {}
mesh_filters = {}   # go_path_id -> mesh_path_id
mesh_renderers = {} # go_path_id -> [material_path_ids]

for obj in env.objects:
    t = obj.type.name
    try:
        data = obj.read()
    except Exception:
        continue

    if t == "GameObject":
        go_names[obj.path_id] = data.m_Name
    elif t == "Mesh":
        subs = len(data.m_SubMeshes) if hasattr(data, "m_SubMeshes") else 0
        meshes[obj.path_id] = {
            "name": data.m_Name,
            "verts": getattr(data, "m_VertexCount", 0),
            "subs": subs
        }
    elif t == "Texture2D":
        textures[obj.path_id] = {
            "name": data.m_Name,
            "w": data.m_Width, "h": data.m_Height
        }
    elif t == "Material":
        tex_refs = {}
        color = None
        if hasattr(data, "m_SavedProperties"):
            sp = data.m_SavedProperties
            if hasattr(sp, "m_TexEnvs"):
                for te in sp.m_TexEnvs:
                    ti = te[1]
                    if hasattr(ti, "m_Texture") and ti.m_Texture:
                        ref = ti.m_Texture
                        pid = getattr(ref, "path_id", 0)
                        if pid: tex_refs[te[0]] = pid
            if hasattr(sp, "m_Colors"):
                for ce in sp.m_Colors:
                    if ce[0] == "_Color":
                        c = ce[1]
                        if hasattr(c, "r"):
                            color = (round(c.r,3), round(c.g,3), round(c.b,3), round(c.a,3))
        materials[obj.path_id] = {"name": data.m_Name, "textures": tex_refs, "color": color}
    elif t == "MeshFilter":
        go_pid = getattr(getattr(data, "m_GameObject", None), "path_id", 0)
        mesh_pid = 0
        if hasattr(data, "m_Mesh") and data.m_Mesh:
            mesh_pid = getattr(data.m_Mesh, "path_id", 0)
        if go_pid and mesh_pid:
            mesh_filters[go_pid] = mesh_pid
    elif t == "MeshRenderer":
        go_pid = getattr(getattr(data, "m_GameObject", None), "path_id", 0)
        mat_ids = []
        if hasattr(data, "m_Materials"):
            for mref in data.m_Materials:
                pid = getattr(mref, "path_id", 0)
                if pid: mat_ids.append(pid)
        if go_pid:
            mesh_renderers[go_pid] = mat_ids

print(f"GameObjects: {len(go_names)}")
print(f"MeshFilters: {len(mesh_filters)}")
print(f"MeshRenderers: {len(mesh_renderers)}")
print(f"Meshes: {len(meshes)}")
print(f"Materials: {len(materials)}")
print(f"Textures: {len(textures)}")

sls_parts = {"SRB", "CoreStage", "ICPS", "Booster", "LAS", "Jettison",
             "LVSA", "R25-", "RS25", "BodyComp", "OGive", "NoseCone",
             "SepMotor", "BottomBrace", "FeedLine", "PressLine", "BoosterMount",
             "RailThing", "MinimizedCore", "Box2015", "Line5901"}

print("\n" + "="*70)
print("ORION IN-FLIGHT COMPONENTS (non-SLS)")
print("="*70)

for go_pid in sorted(mesh_filters.keys(), key=lambda x: go_names.get(x, "")):
    go_name = go_names.get(go_pid, "???")
    mesh_pid = mesh_filters[go_pid]
    mesh_info = meshes.get(mesh_pid, {"name": "?", "verts": 0, "subs": 0})

    if mesh_info["verts"] == 0:
        continue

    is_sls = any(s.lower() in go_name.lower() for s in sls_parts)
    if is_sls:
        continue

    mat_ids = mesh_renderers.get(go_pid, [])
    mat_details = []
    for mid in mat_ids:
        mi = materials.get(mid, {"name": "?", "textures": {}, "color": None})
        tex_detail = {}
        for slot, tpid in mi["textures"].items():
            ti = textures.get(tpid, {"name": "?"})
            tex_detail[slot] = f"{ti['name']} ({ti.get('w','?')}x{ti.get('h','?')})"
        mat_details.append({"name": mi["name"], "color": mi.get("color"), "tex": tex_detail})

    print(f"\n  {go_name}  (mesh: {mesh_info['name']}, {mesh_info['verts']}v, {mesh_info['subs']} subs)")
    for i, md in enumerate(mat_details):
        col = ""
        if md["color"]:
            r,g,b,a = md["color"]
            col = f"  rgba({r},{g},{b},{a})"
        print(f"    mat[{i}]: {md['name']}{col}")
        for slot, desc in md["tex"].items():
            print(f"      {slot}: {desc}")
