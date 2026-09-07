---
schema: Planet
fields:
  - name:
      type: string
      required: true
  - tags:
      type: array
      default: []
  - description:
      type: string
      default: ''
---

# Planet Schema

Defines the base fields for any Planet note.

## Field Reference

| Field | Type | Default | Required |
| --- | --- | --- | --- |
| name | string | - | yes |
| tags | array | [] | no |
| description | string | "" | no |
