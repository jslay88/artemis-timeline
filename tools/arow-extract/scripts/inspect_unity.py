#!/usr/bin/env python3
"""Inspect the NASA AROW Unity data to understand the scene hierarchy,
material assignments, and texture references for the Orion spacecraft."""

import UnityPy
import json, sys, os

env = UnityPy.load("/tmp/arow-extract/WebBuildMar27.data")

# Collect all GameObjects with their component info
game_objects = {}
transforms = {}
meshes = {}
materials = {}
textures = {}
mesh_renderers = {}
mesh_filters = {}

for path, obj in env.container.items():
    data = obj.read()
    t = obj.type.name
    if t == "Texture2D":
        textures[obj.path_id] = {"name": data.m_Name, "path": path, "w": data.m_Width, "h": data.m_Height}
    elif t == "Material":
        tex_refs = {}
        if hasattr(data, "m_SavedProperties"):
            sp = data.m_SavedProperties
            if hasattr(sp, "m_TexEnvs"):
                for te in sp.m_TexEnvs:
                    tex_name = te[0]
                    tex_info = te[1]
                    if hasattr(tex_info, "m_Texture") and tex_info.m_Texture:
                        ref = tex_info.m_Texture
                        if hasattr(ref, "path_id") and ref.path_id != 0:
                            tex_refs[tex_name] = ref.path_id
        materials[obj.path_id] = {"name": data.m_Name, "path": path, "textures": tex_refs}

print("=== MATERIALS ===")
for pid, m in sorted(materials.items(), key=lambda x: x[1]["name"]):
    print(f"  [{pid}] {m['name']}")
    for tname, tpid in m["textures"].items():
        tinfo = textures.get(tpid, {"name": "???"})
        print(f"       {tname} -> {tinfo['name']} ({tinfo.get('w','?')}x{tinfo.get('h','?')})")

# Now inspect non-container objects for mesh/renderer info
print("\n=== SCANNING ALL OBJECTS ===")
mesh_count = 0
renderer_count = 0
for obj in env.objects:
    t = obj.type.name
    if t == "Mesh":
        data = obj.read()
        mesh_count += 1
        sub_count = len(data.m_SubMeshes) if hasattr(data, "m_SubMeshes") else 0
        vert_count = data.m_VertexCount if hasattr(data, "m_VertexCount") else 0
        meshes[obj.path_id] = {"name": data.m_Name, "subs": sub_count, "verts": vert_count}
    elif t == "MeshRenderer":
        data = obj.read()
        renderer_count += 1
        mat_ids = []
        if hasattr(data, "m_Materials"):
            for mref in data.m_Materials:
                if hasattr(mref, "path_id"):
                    mat_ids.append(mref.path_id)
        mesh_renderers[obj.path_id] = {"mats": mat_ids}
    elif t == "MeshFilter":
        data = obj.read()
        mesh_ref = None
        if hasattr(data, "m_Mesh") and data.m_Mesh and hasattr(data.m_Mesh, "path_id"):
            mesh_ref = data.m_Mesh.path_id
        mesh_filters[obj.path_id] = {"mesh": mesh_ref}
    elif t == "GameObject":
        data = obj.read()
        comp_ids = []
        if hasattr(data, "m_Components"):
            for c in data.m_Components:
                comp_ids.append((c.path_id, c.type.name if hasattr(c, "type") else "?"))
        game_objects[obj.path_id] = {"name": data.m_Name, "comps": comp_ids}
    elif t == "Material":
        if obj.path_id not in materials:
            data = obj.read()
            tex_refs = {}
            if hasattr(data, "m_SavedProperties"):
                sp = data.m_SavedProperties
                if hasattr(sp, "m_TexEnvs"):
                    for te in sp.m_TexEnvs:
                        tex_name = te[0]
                        tex_info = te[1]
                        if hasattr(tex_info, "m_Texture") and tex_info.m_Texture:
                            ref = tex_info.m_Texture
                            if hasattr(ref, "path_id") and ref.path_id != 0:
                                tex_refs[tex_name] = ref.path_id
            materials[obj.path_id] = {"name": data.m_Name, "textures": tex_refs}
    elif t == "Texture2D":
        if obj.path_id not in textures:
            data = obj.read()
            textures[obj.path_id] = {"name": data.m_Name, "w": data.m_Width, "h": data.m_Height}

print(f"\nTotal GameObjects: {len(game_objects)}")
print(f"Total Meshes: {mesh_count}")
print(f"Total MeshRenderers: {renderer_count}")
print(f"Total MeshFilters: {len(mesh_filters)}")
print(f"Total Materials: {len(materials)}")
print(f"Total Textures: {len(textures)}")

# Find Orion-related meshes
print("\n=== ORION-RELATED MESHES (in-flight: CM + SM + solar) ===")
orion_keywords = [
    "UnifiedCM", "UnifiedSM", "Capsule", "Panel", "Thruster",
    "Nozzle", "Fairing", "Flag", "Meatball", "Worm", "ESA",
    "Artemis", "Cover", "Ring", "Torus", "RedParts", "Logo",
    "pPlane", "icosahedron", "SM_esa"
]
sls_keywords = ["SRB", "CoreStage", "ICPS", "Booster", "LAS", "Jettison",
                "LVSA", "R25", "RS25", "FeedLine", "PressLine",
                "BodyComponents", "OGive", "NoseCone"]

for pid, m in sorted(meshes.items(), key=lambda x: x[1]["name"]):
    name = m["name"]
    is_orion = any(k.lower() in name.lower() for k in orion_keywords)
    is_sls = any(k.lower() in name.lower() for k in sls_keywords)
    tag = ""
    if is_orion: tag = " [ORION]"
    elif is_sls: tag = " [SLS-skip]"
    if m["verts"] > 0:
        print(f"  {name}: {m['verts']} verts, {m['subs']} submeshes{tag}")

print("\n=== ALL MATERIALS (with full texture info) ===")
for pid, m in sorted(materials.items(), key=lambda x: x[1]["name"]):
    print(f"  [{pid}] {m['name']}")
    for tname, tpid in m["textures"].items():
        tinfo = textures.get(tpid, {"name": "???", "w": "?", "h": "?"})
        print(f"       {tname} -> {tinfo['name']} ({tinfo.get('w','?')}x{tinfo.get('h','?')})")
