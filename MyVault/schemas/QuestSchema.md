---
schema: Quest
fields:
  - title:
      type: string
      required: true
  - status:
      type: string
      default: inactive
  - giver:
      type: string
      default: ''
  - reward:
      type: string
      default: ''
  - difficulty:
      type: string
      default: normal
  - tags:
      type: array
      default: []
  - description:
      type: string
      default: ''
---

# Quest Schema

Defines the base fields for any Quest note.

## Field Reference

| Field | Type | Default | Required |
| --- | --- | --- | --- |
| title | string | - | yes |
| status | string | "inactive" | no |
| giver | string | "" | no |
| reward | string | "" | no |
| difficulty | string | "normal" | no |
| tags | array | [] | no |
| description | string | "" | no |
