# Island people and vehicles: raw Tripo3D outputs

These six files are the models as Tripo3D returned them. They are raw inputs to the engine's
`tools/samples/blender/island-life.py`, which finishes them into `showcase/island-life/life.glb`.
The engine does not name these files and does not load them: it loads the finished file.

## What made them

Each picture was made with `google/nano-banana-2.1` on fal.ai from the island brief, and each model
with Tripo3D image to model. The reference pictures live in the scene-references repository under
`generated/island/`: the first three at commit `18e8e33`, the woman's and the young man's at
`5ccaf23`. Their prompts are in `prompts/` beside this file.

| Raw folder | Reference shot | Shot SHA-256 | fal request id |
|---|---|---|---|
| `villager/` | `generated/island/villager-front.png` | `3b7051699f526ee5a63c4f540e93da5d61f8496b986d0e1614e356a9f371d5d4` | `01a200dd-edcb-70d2-a4e2-d37292c93713` |
| `hatchback/` | `generated/island/hatchback-front.png` | `e6a924897c7a1e43fd9500531bd800cb0c773b52ae2ca57b39e0ed9fa1bffd82` | `01a200de-2fcb-78e2-b150-5a883b179b6a` |
| `minibus/` | `generated/island/minibus-front.png` | `98cfc98580aa4ed1deb806609d6cb28043773e23dfee32286c03cfb4a81e3a7e` | `01a200de-6f29-7dd0-b426-f702b528a839` |
| `villager-walk/` | the villager above | same | same |
| `woman/` | `generated/island/woman-front.png` | `11fb374a18e139bf898be00811474407026c455092e2fdb9e3d633f67370a950` | `01a20100-4065-7481-9621-754c736f9f63` |
| `youngman/` | `generated/island/youngman-front.png` | `91dca78f976156d4c56c79a2dd8ee5c7342ae81fae5002f3cb7b9fe50ed83bb1` | `01a20100-8c74-7ce3-9b00-ed405fcfbde5` |

Each person was generated, rigged with Tripo3D's biped and then retargeted with an in-place
`preset:walk` clip, with geometry included. Only the walk task's output is copied: the base model and
the rig were intermediates. The woman's and young man's walk models keep their base model's mesh
names, which name those tasks.

| Raw folder | Base model task | Rig task | Walk task |
|---|---|---|---|
| `villager/` | `33d0b431-b4c7-41d4-9735-c4b1d48b3415` (30) | none | none |
| `villager-walk/` | the villager above | `0ce39537-7dd3-4704-b79d-c72c1e10fa64` (25) | `c05316a7-e62d-4b5b-ae74-6b9a913eaf71` (10) |
| `hatchback/` | `a31f3e57-1f42-4be9-8d9d-f8a6403d9e27` (30) | none | none |
| `minibus/` | `28093e96-b897-4eed-86f3-2ba3a68f5a1a` (30) | none | none |
| `woman/` | `e159d895-a455-452a-a26c-8e4da5abf9a7` (30) | `36bdf43e-ec4b-43f2-8fef-155308fbb774` (25) | `3dbee63f-6ab0-4759-addf-6e57b72ff6cb` (10) |
| `youngman/` | `36a8a355-ba3d-4bb9-a3b5-a058d926f9c9` (30) | `2e866ec2-5e7b-4295-881c-cc3c7631cfaf` (25) | `64cfc449-1127-4e23-a519-69f79dae6a9b` (10) |

The tasks behind the six copied files cost 120 credits. The three rigs add 75 and the woman's and
young man's base models add 60, so the pipeline cost 255 credits: the villager's 65, the woman's 65,
the young man's 65, the hatchback's 30 and the minibus's 30. The woman and young man together cost
130. The account records 255 spent and a balance of 335.

## The files

- `model.glb` is the downloaded model, unchanged.
- `task.json` is the task as Tripo3D returned it, with the account's storage path in `input.file`
  replaced by a placeholder.
- `preview.webp` is Tripo3D's preview. Tripo3D serves it as a WebP picture.
- `villager-walk/`, `woman/` and `youngman/` have no preview: their tasks returned no picture.

## Sizes in the raw files

Tripo3D wrote each model's real size into its root node's uniform scale: the villager stands 1.8 m,
the woman 1.70 m, the young man 1.80 m, the hatchback is 3.69 m long and the minibus 4.13 m long.
The finished file sets the villager at 1.75 m, keeps the woman and young man at their own heights,
and sets the hatchback at 3.7 m and the minibus at 4.9 m, in Blender.
