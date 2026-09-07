# AssetDatabase Database

Generated DBML base view for the DBML Visualizer plugin.

```dbml title="AssetDatabase ERD"
Table Verse {
  Realm varchar
  LifeForm varchar
  Culture varchar
  Architecture varchar
  Service varchar
  FactionAlignment varchar
  Weather varchar
  Event varchar
}

Table Realm {
  Realm varchar [not null]
}

Table LifeForm {
  id varchar [not null]
  cover varchar
  trait varchar
}
Ref: Verse.Realm > Realm.Realm
```
