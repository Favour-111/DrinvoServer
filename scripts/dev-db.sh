#!/bin/sh
# Starts a local MongoDB single-node replica set for development.
# Transactions (used by sales, returns and restocks) need a replica set.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)/.data/db"
PORT="${MONGO_PORT:-27017}"
mkdir -p "$DIR"

if ! command -v mongod >/dev/null 2>&1; then
  echo "mongod not found. Install MongoDB 7+ (brew install mongodb-community@7.0)." >&2
  exit 1
fi

echo "Starting mongod (replica set rs0) on port $PORT, data in $DIR"
mongod --replSet rs0 --port "$PORT" --dbpath "$DIR" --bind_ip 127.0.0.1 --fork --logpath "$DIR/../mongod.log"

# Initiate the replica set once
mongosh --quiet --port "$PORT" --eval '
try { rs.status(); print("Replica set already initiated."); }
catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:'"$PORT"'" }] }); print("Replica set initiated."); }'

echo "MongoDB ready: mongodb://127.0.0.1:$PORT/drinvo?replicaSet=rs0"
echo "Stop it with: mongosh --port $PORT admin --eval 'db.shutdownServer()'"
