'use strict'

const { test } = require('uvu')
const { expect } = require('expect')
const { execSync } = require('node:child_process')
const Mongoose = require('mongoose')
const { off } = require('node:process')

const { MONGODB_PORT = "27017", MONGODB_PORTS = "27017,27117,27217", MONGODB_REPLICA_SET = 'mongodb-test-rs' } = process.env
const PORTS = MONGODB_PORTS.split(",")

function runCmd(cmd) {
  try {
    return execSync(cmd).toString()
  } catch (err) {
    console.error("could not execute command: ", cmd)
    err.output.forEach(o =>{
      if(o!=null) {console.error("output ", o.toString())}
    })
    return "err"
  }
}

function setupDns() {
  let indexes = Array.from({length: PORTS.length}, (v,k)=>k+1)
  indexes.forEach(i => {
    let containerName = `mongodb-${i}`
    let findIpCmd = `docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`
    let ip = runCmd(findIpCmd).toString().trim()
    runCmd(`echo \"${ip} ${containerName}\" | sudo tee -a /etc/hosts`)
  })
}

function executeMongoCmd(node, cmd) {
  let docker_cmd = `docker exec ${node} mongo localhost:${MONGODB_PORT} --eval \"${cmd}\"`
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

test.before(async () => {
  const hostsStrings = PORTS.map(x => `localhost:${x}`)
  const hostsString = hostsStrings.join(",")
  const connectionString = `mongodb://${hostsString}/`

  console.log('---------------------------------------------------------------------')
  console.log('connecting to MongoDB using connection string -> ' + connectionString)
  console.log('---------------------------------------------------------------------')

  try {
    await Mongoose.connect(connectionString, {
      serverSelectionTimeoutMS: 1500,
      keepAlive: true
    })
  } catch (error) {
    console.log(error)
  }
})

test.after(async () => {
  await Mongoose.connection.db.dropDatabase()
  await Mongoose.disconnect()
})

test('queries the replica set status', async () => {
  const db = Mongoose.connection.db.admin()
  const { ok, set, members } = await db.command({ replSetGetStatus: 1 })

  expect(ok).toBe(1)
  expect(set).toEqual(MONGODB_REPLICA_SET)
})

test('repeatedly reads document as rs members die', async () => {
  const Dog = Mongoose.model('Dog', { name: String })

  const albert1 = await new Dog({ name: 'Albert' }).save()
  expect(albert1.name).toEqual('Albert')


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
