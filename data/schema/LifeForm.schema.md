---
schema: LifeForm
fields:
  - id:
      type: string
      required: true
  - cover:
      type: attachment
  - trait:
      type: string
---

# LifeForm Schema

Defines the base fields for any LifeForm note.

## Field Reference

| Field | Type | Default | Required | Bound |
| --- | --- | --- | --- | --- |
| id | string | - | yes | yes |
| cover | attachment | - | no | yes |
| trait | string | - | no | yes |
