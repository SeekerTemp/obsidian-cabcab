---
schema: Verse
schemaSource: config/entity.md
fields:
  - Realm:
      type: string
      relation: Realm
  - LifeForm:
      type: string
  - Culture:
      type: string
  - Architecture:
      type: string
  - Service:
      type: string
  - FactionAlignment:
      type: string
  - Weather:
      type: string
  - Event:
      type: string
---

# Verse Schema

Source implementation: [[config/entity]]

Defines the base fields for any Verse note.

## Field Reference

| Field | Type | Default | Required | Bound |
| --- | --- | --- | --- | --- |
| Realm | string | - | no | yes |
| LifeForm | string | - | no | yes |
| Culture | string | - | no | yes |
| Architecture | string | - | no | yes |
| Service | string | - | no | yes |
| FactionAlignment | string | - | no | yes |
| Weather | string | - | no | yes |
| Event | string | - | no | yes |
