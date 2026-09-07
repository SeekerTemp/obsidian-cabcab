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
  - cover1:
      type: attachment
      bind: false
  - trait1:
      type: string
      bind: false
  - attachment:
      type: string
      bind: false
  - string:
      type: string
      bind: false
  - temp:
      type: string
  - temp2:
      type: string
---

# LifeForm Schema

Defines the base fields for any LifeForm note.

## Field Reference

| Field | Type | Default | Required | Bound | Relation |
| --- | --- | --- | --- | --- | --- |
| id | string | - | yes | yes | - |
| cover | attachment | - | no | yes | - |
| trait | string | - | no | yes | - |
| cover1 | attachment | - | no | no | - |
| trait1 | string | - | no | no | - |
| attachment | string | - | no | no | - |
| string | string | - | no | no | - |
| temp | string | - | no | yes | - |
| temp2 | string | - | no | yes | - |

<!-- schema-sync:notes -->

_Anything you write below this marker is preserved across syncs._
