#!/bin/sh

# Map input values from the GitHub Actions workflow to shell variables
MONGODB_VERSION=$1
MONGODB_REPLICA_SET=$2
MONGODB_PORT=$3
MONGODB_DB=$4
MONGODB_USERNAME=$5
MONGODB_PASSWORD=$6
MONGODB_REPLICA_SET_NODE_PORTS=$7

nth()
{
  POSITION=$1
  ARRAY=$2
  echo $ARRAY | cut -d " " -f $POSITION
}


if [ -z "$MONGODB_VERSION" ]; then
  echo ""
  echo "Missing MongoDB version in the [mongodb-version] input. Received value: $MONGODB_VERSION"
  echo ""

  exit 2
fi


echo "::group::Selecting correct MongoDB client"
if [ "`echo $MONGODB_VERSION | cut -c 1`" = "4" ]; then
  MONGO_CLIENT="mongo"
else
  MONGO_CLIENT="mongosh --quiet"
fi
echo "  - Using [$MONGO_CLIENT]"
echo ""
echo "::endgroup::"


if [ -z "$MONGODB_REPLICA_SET" ]; then
  echo "::group::Starting single-node instance, no replica set"
  echo "  - port [$MONGODB_PORT]"
  echo "  - version [$MONGODB_VERSION]"
  echo "  - database [$MONGODB_DB]"
  echo "  - credentials [$MONGODB_USERNAME:$MONGODB_PASSWORD]"
  echo ""

  docker run --name mongodb --publish $MONGODB_PORT:27017 -e MONGO_INITDB_DATABASE=$MONGODB_DB -e MONGO_INITDB_ROOT_USERNAME=$MONGODB_USERNAME -e MONGO_INITDB_ROOT_PASSWORD=$MONGODB_PASSWORD --detach mongo:$MONGODB_VERSION

  if [ $? -ne 0 ]; then
      echo "Error starting MongoDB Docker container"
      exit 2
  fi
  echo "::endgroup::"
  return
fi

RS_PORTS=`echo $MONGODB_REPLICA_SET_NODE_PORTS | tr "," "\n"`
RS_PORTS_COUNT=`echo $RS_PORTS | wc -w`

echo "::group::Starting MongoDB replica set with $RS_PORTS_COUNT node(s)"
echo "  - port [$MONGODB_PORT]"
echo "  - version [$MONGODB_VERSION]"
echo "  - replica set [$MONGODB_REPLICA_SET]"
echo "  - replica set node:ports :"

RS_NODES_INDEXES=`seq 1 $RS_PORTS_COUNT`
for i in $RS_NODES_INDEXES
do
  echo "     - mongodb-$i:$(nth $i "$RS_PORTS")"
done
echo ""

echo "::group::Creating Docker network for name resolution"
docker network create mongonet
echo ""
echo "::endgroup::"

for i in $RS_NODES_INDEXES
do
  docker run --name mongodb-$i --publish $(nth $i "$RS_PORTS"):$MONGODB_PORT --network mongonet --detach mongo:$MONGODB_VERSION --replSet $MONGODB_REPLICA_SET --port $MONGODB_PORT

  if [ $? -ne 0 ]; then
      echo "Error starting mongodb-$i MongoDB Docker container"
      exit 2
  fi
  echo "::endgroup::"


  echo "::group::Waiting for mongodb-$i MongoDB to accept connections"
  sleep 1
  TIMER=0

  until docker exec --tty mongodb-$i $MONGO_CLIENT --port $MONGODB_PORT --eval "db.serverStatus()"
  do
    sleep 1
    echo "."
    TIMER=$((TIMER + 1))

    if [[ $TIMER -eq 20 ]]; then
      echo "mongodb-$i MongoDB did not initialize within 20 seconds. Exiting."
      exit 2
    fi
  done
  echo "::endgroup::"
done

echo "::group::Initiating replica set [$MONGODB_REPLICA_SET] at mongodb-1"
for i in $RS_NODES_INDEXES
do
  MEMBERS_CONFIG=${MEMBERS_CONFIG:+$MEMBERS_CONFIG},"{\"_id\":$i, \"host\": \"mongodb-$i:$MONGODB_PORT\"}"
done
MEMBERS_CONFIG="${MEMBERS_CONFIG:1}"

docker exec --tty mongodb-1 $MONGO_CLIENT --port $MONGODB_PORT --eval "
  rs.initiate({
    \"_id\": \"$MONGODB_REPLICA_SET\",
    \"members\": [$MEMBERS_CONFIG]
  })
"

echo "Success! Initiated replica set [$MONGODB_REPLICA_SET]"
echo "::endgroup::"

sleep 5
for i in $RS_NODES_INDEXES
do
  echo "::group::Checking replica set status [$MONGODB_REPLICA_SET] at mongodb-$i"
    docker exec --tty mongodb-$i $MONGO_CLIENT --port $MONGODB_PORT --eval "
      rs.status()
    "
    echo "::endgroup::"
done
