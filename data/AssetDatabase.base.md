# AssetDatabase Database

Generated DBML base view for the DBML Visualizer plugin.

```dbml title="AssetDatabase ERD"
Table MediaInstance {
  media varchar [not null]
  source varchar
  op varchar
  crop varchar
  transform varchar
  sourceTime int
  sourceStart int
  sourceEnd int
  clips varchar
  width int
  height int
  created varchar
  useCase varchar
  shows varchar
  status varchar
  labels varchar
}

Table Verse {

}

Table Realm {
  Realm varchar [not null]
}

Table LifeForm {
  id varchar [not null]
  cover varchar
  trait varchar
  temp varchar
  temp2 varchar
}

```

<!-- schema-sync:notes -->

_Anything you write below this marker is preserved across syncs._
