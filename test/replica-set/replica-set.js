'use strict'

const { test } = require('uvu')
const { expect } = require('expect')
const { execSync } = require('node:child_process')
const Mongoose = require('mongoose')
const { off } = require('node:process')

const { 
  MONGODB_PORT = "27017", 
  MONGODB_PORTS = "27017,27117,27217", 
  MONGODB_REPLICA_SET = 'mongodb-test-rs' 
} = process.env
const PORTS = MONGODB_PORTS.split(",")

let rs_conns;

function runCmd(cmd) {
  return execSync(cmd).toString()
}

function container_name(node_number) {
  return `mongodb-${node_number}`
}

function setupDns(mongo_version) {
  let indexes = Array.from({length: PORTS.length}, (v,k)=>k+1)
  indexes.forEach(i => {
    let containerName = container_name(i)
    let findIpCmd = `docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`
    let ip = runCmd(findIpCmd).toString().trim()
    runCmd(`echo \"${ip} ${containerName}\" | sudo tee -a /etc/hosts`)
  })
}

function executeMongoCmd(node, cmd) {
  let docker_cmd = `docker exec ${node} mongo localhost:${MONGODB_PORT}/test --eval "${cmd}"`
  let out = runCmd(docker_cmd)
  console.log(node, "output for executeMongoCmd", cmd,"\n", out)
  return out
}

function stopRsNode(index) {
  let containerName = `mongodb-${index}`
  runCmd(`docker kill ${containerName}`)
  console.log(`container ${containerName} stopped`)
}

function waitCmdOutHas(cmd, strToHave) {
  let indexes = Array.from({length: PORTS.length}, (_v,k)=>k+1)
  indexes.forEach(i => {
    let containerName = `mongodb-${i}`
    while (executeMongoCmd(containerName, cmd).includes(strToHave) == false) {
      console.log(`Waiting ${containerName} is secondary ok`)
      execSync('sleep 1');
    }
  })
}

setupDns()

async function createConnections(hostStrings) {
  const connectionOptions = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  };

  const connectionPromises = new Map(hostStrings.map(async (hostString) => {
    try {
      let connectionString = `mongodb://${hostString}?replicaSet=${MONGODB_REPLICA_SET}&readPreference=primaryPreferred`
      let connection = Mongoose.createConnection(connectionString, connectionOptions);
      await connection.asPromise();
      console.log(`Mongoose connection successful for ${connectionString}`);
      return [hostString, connection];
    } catch (error) {
      console.error(`Mongoose connection failed for ${connectionString}:`, error);
      throw error;
    }
  }));

  try {
    let connections = await Promise.all(connectionPromises);
    console.log('All connections successful');
    return connections;
  } catch (error) {
    console.error('One or more connections failed:', error);
    throw error; 
  }
}

function get_primary_conn() {
  let primary_member;
  console.log(rs_conns)
  Array.from(rs_conns).forEach(async ([hostString, conn]) => {
    console.log(db)
    const { ok, set, members } = await conn.db.admin().command({ replSetGetStatus: 1 })
    let node_primary = members.find(function(neighbour) {
      return (1 == neighbour.state)
    })
    if (primary_member == null) {
      primary_member = node_primary
    }
    if (primary_member !== node_primary); return "unknown"
  })
  let primary_hostString = primary.name()
  return rs_conns.get(primary_hostString)
}

test.before(async () => {
  const hostStrings = PORTS.map(x => `localhost:${x}`)

  console.log('---------------------------------------------------------------------')
  await createConnections(hostStrings)
  .then((conns) => {
    console.log('All connections established.');
    console.log('---------------------------------------------------------------------')
    rs_conns=conns
  })
  .catch((error) => {
    console.error('One or more connections failed:', error);
    throw(error)
  })
})

test.after(async () => {
  await Mongoose.disconnect()
})

test('queries the replica set status', async () => {
  let neighbours;
  rs_conns.forEach(async (conn) => {
    const { ok, set, members } = await conn.db.admin().command({ replSetGetStatus: 1 })
    console.log(set)
    console.log(members)
    expect(ok).toBe(1)
    expect(set).toEqual(MONGODB_REPLICA_SET)
    if (neighbours == null) {
      neighbours = members
    }
    expect(members).toEqual(neighbours)
  })
})

test('repeatedly reads document as rs members die', async () => {
  let primary_node_conn = get_primary_conn()
  console.log("Primary node conn:", primary_node_conn)

  // const dog1 = 

  expect(dog1.name).toEqual('Albert')

  executeMongoCmd("mongodb-1", "db.dogs.find({})")

  waitCmdOutHas("db.dogs.find({})", "\"name\" : \"Albert\"")
  stopRsNode(1)
  waitCmdOutHas("db.dogs.find({})", "\"name\" : \"Albert\"")

  const albert2 = await Dog.find({name: 'Albert'}).exec()
  expect(albert2.name).toEqual('Albert')

  waitCmdOutHas("db.dogs.find({})", "\"name\" : \"Albert\"")
  stopRsNode(2)
  waitCmdOutHas("db.dogs.find({})", "\"name\" : \"Albert\"")

  const albert3 = await Dog.find({name: 'Albert'}).exec()
  expect(albert3.name).toEqual('Albert')
})

test('uses transactions', async () => {
  const Customer = Mongoose.model('Customer', new Mongoose.Schema({ name: String }))
  await Customer.createCollection()

  const session = await Mongoose.startSession()
  session.startTransaction()

  await Customer.create([{ name: 'test-customer' }], { session })

  expect(
    await Customer.findOne({ name: 'test-customer' })
  ).toBeNull()

  expect(
    await Customer.findOne({ name: 'test-customer' }).session(session)
  ).not.toBeNull()

  await session.commitTransaction()

  expect(
    await Customer.findOne({ name: 'test-customer' })
  ).not.toBeNull()
})

test.run()
