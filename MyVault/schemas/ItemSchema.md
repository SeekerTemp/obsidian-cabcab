---
schema: Item
fields:
  - name:
      type: string
      required: true
  - itemType:
      type: string
      default: misc
  - rarity:
      type: string
      default: common
  - value:
      type: number
      default: 0
  - weight:
      type: number
      default: 0
  - stackable:
      type: boolean
      default: false
  - tags:
      type: array
      default: []
  - description:
      type: string
      default: ''
---

# Item Schema

Defines the base fields for any Item note.

## Field Reference

| Field | Type | Default | Required |
| --- | --- | --- | --- |
| name | string | - | yes |
| itemType | string | "misc" | no |
| rarity | string | "common" | no |
| value | number | 0 | no |
| weight | number | 0 | no |
| stackable | boolean | false | no |
| tags | array | [] | no |
| description | string | "" | no |
