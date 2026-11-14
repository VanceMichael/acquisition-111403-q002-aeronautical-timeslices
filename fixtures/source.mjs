export const seed={
  "facility": "stand1",
  "sliceId": "b1",
  "properties": {
    "open": true,
    "capacity": 2
  }
};
export const seedPath="/baseline";
export const routes=[
  {
    "path": "/slices",
    "body": {
      "items": [
        {
          "sliceId": "b1",
          "facility": "stand1",
          "interpretation": "BASELINE",
          "sequence": 1,
          "correction": 0,
          "validStart": 0,
          "validEnd": null,
          "properties": {
            "open": true,
            "capacity": 2
          }
        }
      ],
      "next": "/slices?facility=stand1&page=2"
    },
    "method": "GET",
    "status": 200,
    "query": {
      "facility": "stand1",
      "page": "1"
    },
    "headers": {}
  },
  {
    "path": "/slices",
    "body": {
      "items": [
        {
          "sliceId": "t1",
          "facility": "stand1",
          "interpretation": "TEMPDELTA",
          "sequence": 1,
          "correction": 0,
          "validStart": 10,
          "validEnd": 20,
          "properties": {
            "open": false
          }
        }
      ],
      "next": null
    },
    "method": "GET",
    "status": 200,
    "query": {
      "facility": "stand1",
      "page": "2"
    },
    "headers": {}
  },
  {
    "path": "/slices/b1",
    "body": {
      "sliceId": "b1",
      "facility": "stand1",
      "interpretation": "BASELINE",
      "sequence": 1,
      "correction": 0,
      "validStart": 0,
      "validEnd": null,
      "properties": {
        "open": true,
        "capacity": 2
      }
    },
    "method": "GET",
    "status": 200,
    "query": {},
    "headers": {}
  },
  {
    "path": "/slices/t1",
    "body": {
      "sliceId": "t1",
      "facility": "stand1",
      "interpretation": "TEMPDELTA",
      "sequence": 1,
      "correction": 0,
      "validStart": 10,
      "validEnd": 20,
      "properties": {
        "open": false
      }
    },
    "method": "GET",
    "status": 200,
    "query": {},
    "headers": {}
  }
];
export const phases={
  "late": [
    {
      "path": "/slices",
      "body": {
        "items": [
          {
            "sliceId": "p1",
            "facility": "stand1",
            "interpretation": "PERMDELTA",
            "sequence": 2,
            "correction": 1,
            "validStart": 5,
            "validEnd": null,
            "properties": {
              "capacity": 3
            }
          },
          {
            "sliceId": "cancel1",
            "facility": "stand1",
            "cancelOf": "t1",
            "validStart": 12,
            "validEnd": null,
            "properties": {}
          }
        ],
        "next": null
      },
      "method": "GET",
      "status": 200,
      "query": {
        "facility": "stand1",
        "page": "1"
      },
      "headers": {}
    }
  ],
  "overlap": [
    {
      "path": "/slices",
      "body": {
        "items": [
          {
            "sliceId": "t2",
            "facility": "stand1",
            "interpretation": "TEMPDELTA",
            "sequence": 1,
            "correction": 0,
            "validStart": 15,
            "validEnd": 25,
            "properties": {
              "open": true
            }
          },
          {
            "sliceId": "t1",
            "facility": "stand1",
            "interpretation": "TEMPDELTA",
            "sequence": 1,
            "correction": 0,
            "validStart": 10,
            "validEnd": 20,
            "properties": {
              "open": false
            }
          }
        ],
        "next": null
      },
      "method": "GET",
      "status": 200,
      "query": {
        "facility": "stand1",
        "page": "1"
      },
      "headers": {}
    }
  ]
};
export const portalKind="";
