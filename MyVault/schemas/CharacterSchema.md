---
schema: Character
fields:
  - name:
      type: string
      required: true
  - hp:
      type: number
      default: 100
  - mana:
      type: number
      default: 0
  - level:
      type: number
      default: 1
  - tags:
      type: array
      default: []
  - faction:
      type: string
      default: neutral
  - description:
      type: string
      default: ''
---

# Character Schema

Defines the base fields for any Character note.

## Field Reference

| Field | Type | Default | Required |
| --- | --- | --- | --- |
| name | string | - | yes |
| hp | number | 100 | no |
| mana | number | 0 | no |
| level | number | 1 | no |
| tags | array | [] | no |
| faction | string | "neutral" | no |
| description | string | "" | no |
