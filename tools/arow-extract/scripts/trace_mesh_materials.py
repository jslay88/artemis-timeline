#!/usr/bin/env python3
"""Trace GameObject → MeshFilter → MeshRenderer → Material → Texture
for Orion spacecraft meshes."""

import UnityPy

env = UnityPy.load("/tmp/arow-extract/WebBuildMar27.data")

game_objects = {}
transforms = {}
meshes_by_id = {}
materials_by_id = {}
textures_by_id = {}

# First pass: collect everything
for obj in env.objects:
    t = obj.type.name
    try:
        data = obj.read()
    except Exception:
        continue
    if t == "GameObject":
        comps = []
        if hasattr(data, "m_Components"):
            for c in data.m_Components:
                comps.append(c)
        game_objects[obj.path_id] = {"name": data.m_Name, "comps": comps, "obj": data}
    elif t == "Transform":
        parent_id = 0
        if hasattr(data, "m_Father") and data.m_Father and hasattr(data.m_Father, "path_id"):
            parent_id = data.m_Father.path_id
        go_id = 0
        if hasattr(data, "m_GameObject") and data.m_GameObject:
            go_id = data.m_GameObject.path_id
        transforms[obj.path_id] = {"parent": parent_id, "go": go_id}
    elif t == "Mesh":
        sub_count = len(data.m_SubMeshes) if hasattr(data, "m_SubMeshes") else 0
        meshes_by_id[obj.path_id] = {
            "name": data.m_Name,
            "verts": data.m_VertexCount if hasattr(data, "m_VertexCount") else 0,
            "subs": sub_count
        }
    elif t == "Material":
        tex_refs = {}
        color = None
        if hasattr(data, "m_SavedProperties"):
            sp = data.m_SavedProperties
            if hasattr(sp, "m_TexEnvs"):
                for te in sp.m_TexEnvs:
                    tex_info = te[1]
                    if hasattr(tex_info, "m_Texture") and tex_info.m_Texture:
                        ref = tex_info.m_Texture
                        if hasattr(ref, "path_id") and ref.path_id != 0:
                            tex_refs[te[0]] = ref.path_id
            if hasattr(sp, "m_Colors"):
                for ce in sp.m_Colors:
                    if ce[0] == "_Color":
                        c = ce[1]
                        color = (c.r, c.g, c.b, c.a) if hasattr(c, "r") else None
        materials_by_id[obj.path_id] = {
            "name": data.m_Name, "textures": tex_refs, "color": color
        }
    elif t == "Texture2D":
        textures_by_id[obj.path_id] = {"name": data.m_Name, "w": data.m_Width, "h": data.m_Height}

# Second pass: find MeshFilter + MeshRenderer per GameObject
results = []
for obj in env.objects:
    t = obj.type.name
    if t == "MeshFilter":
        try:
            data = obj.read()
        except Exception:
            continue
        go_id = data.m_GameObject.path_id if hasattr(data, "m_GameObject") and data.m_GameObject else 0
        mesh_id = data.m_Mesh.path_id if hasattr(data, "m_Mesh") and data.m_Mesh and hasattr(data.m_Mesh, "path_id") else 0
        
        go_name = game_objects.get(go_id, {}).get("name", "???")
        mesh_info = meshes_by_id.get(mesh_id, {"name": "???", "verts": 0, "subs": 0})
        
        # Find the MeshRenderer for this same GameObject
        mat_names = []
        for obj2 in env.objects:
            if obj2.type.name == "MeshRenderer":
                try:
                    d2 = obj2.read()
                except Exception:
                    continue
                if hasattr(d2, "m_GameObject") and d2.m_GameObject and d2.m_GameObject.path_id == go_id:
                    if hasattr(d2, "m_Materials"):
                        for mref in d2.m_Materials:
                            mid = mref.path_id if hasattr(mref, "path_id") else 0
                            minfo = materials_by_id.get(mid, {"name": "???", "textures": {}})
                            tex_detail = {}
                            for tslot, tpid in minfo["textures"].items():
                                tinfo = textures_by_id.get(tpid, {"name": "???"})
                                tex_detail[tslot] = tinfo["name"]
                            mat_names.append({
                                "name": minfo["name"],
                                "color": minfo.get("color"),
                                "textures": tex_detail
                            })
                    break
        
        if mesh_info["verts"] > 0:
            results.append({
                "go": go_name,
                "mesh": mesh_info["name"],
                "verts": mesh_info["verts"],
                "subs": mesh_info["subs"],
                "materials": mat_names
            })

# Sort by name and print
sls_parts = {"SRB", "CoreStage", "ICPS", "Booster", "LAS", "Jettison", 
             "LVSA", "R25", "RS25", "BodyComp", "OGive", "NoseCone",
             "SepMotor", "BottomBrace", "FeedLine", "PressLine", "BoosterMount",
             "RailThing", "MinimizedCore", "Box2015"}

for r in sorted(results, key=lambda x: x["go"]):
    is_sls = any(s.lower() in r["go"].lower() for s in sls_parts)
    tag = " [SLS]" if is_sls else ""
    print(f"\n{'='*60}")
    print(f"GO: {r['go']}{tag}")
    print(f"  Mesh: {r['mesh']}  ({r['verts']} verts, {r['subs']} submeshes)")
    for i, m in enumerate(r["materials"]):
        col = f" color=({m['color'][0]:.2f},{m['color'][1]:.2f},{m['color'][2]:.2f})" if m.get("color") else ""
        print(f"  Material[{i}]: {m['name']}{col}")
        for slot, tname in m["textures"].items():
            print(f"    {slot}: {tname}")
