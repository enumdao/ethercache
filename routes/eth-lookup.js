var express = require('express');
var router = express.Router();
const { providers } = require('ethers');
const redis = require('../modules/redis');

const ETH_API_SERVER = `https://eth-mainnet.alchemyapi.io/v2/${process.env.ether_token}`;

/*
 * {
 *  [key: string]: {
 *    phone: string,
 *    address: string,
 *    goodTill: number
 *  }
 * }
 */
const memoryCache = {};

class NotFoundError extends Error {
  constructor(message, name, address) {
    super(message);

    this.name = name;
    this.code = 404;
    this.address = address;
  }

  toInformativeObject() {
    return { name: this.name, address: this.address, message: this.message };
  }
}

async function doLookup(name) {
  const provider = new providers.JsonRpcProvider(ETH_API_SERVER);
  const resolver = await provider.getResolver(name);
  if (!resolver) {
    throw new NotFoundError('ENS name was not found', 'ENSNotFound', null);
  }

  const [address, phone] = await Promise.all([
    resolver.getAddress(),
    resolver.getText('phone'),
  ]);

  if (!phone) {
    throw new NotFoundError(
      'ENS name did not have a phone number',
      'PhoneNotFound',
      address
    );
  }

  return { name, phone, address };
}

async function saveNameUrl(lookupObject, minutes = 5) {
  const secondsPerMinute = 60;

  const client = await redis.init(process.env.REDIS_URL);
  await client.set(
    lookupObject.name,
    JSON.stringify({
      phone: lookupObject.phone,
      address: lookupObject.address,
    })
  );
  await client.expire(lookupObject.name, minutes * secondsPerMinute);
  await client.quit();
}

async function getUrl(name) {
  const client = await redis.init(process.env.REDIS_URL);
  const memoryItem = await client.get(name);
  await client.quit();

  if (memoryItem) {
    return {
      name,
      ...JSON.parse(memoryItem),
    };
  }

  const lookupObject = await doLookup(name);
  if (lookupObject) {
    let minutes = process.env.REDIS_EXPIRATION_MINUTES;
    if (typeof minutes === 'string') minutes = parseInt(minutes);

    await saveNameUrl(lookupObject, minutes);
  }

  return lookupObject;
}

router.get('/', async (request, response) => {
  try {
    const name = request.query.name;

    if (name && name != '') {
      const lookupObject = await getUrl(name);
      response.setHeader('Content-Type', 'application/json');
      return response.status(200).send(lookupObject);
    }

    return response.status(400).send({
      message: 'Name was not provided. Name is a required query param.',
      name: 'BadRequest',
    });
  } catch (e) {
    if (e instanceof NotFoundError) {
      return response.status(e.code).send(e.toInformativeObject());
    }

    console.error('Unexpected error:', e);
  }

  return response
    .status(500)
    .send({ message: 'Unexpected error occurred', name: 'UnexpectedError' });
});

module.exports = router;
