var secret = require('./secret.json');
var Hapi = require('hapi');
var Joi = require('joi');

function unique() {
  return Date.now().toString(32) + Math.random().toString(32).substring(2);
}

var cypher = require('cypher-rest');
var readUrl = secret.neo4j.url;
function doQuery(query) {
  console.log(query);
  return cypher.run(query, readUrl);
}

var APPLICATION_FEE = 0.03;
var CURRENT_AMOUNT = 2099.97;
var CURRENT_CURRENCY = 'usd';
var CURRENT_USER = 'tomhanks@example.com';
var DISTRIBUTOR_EMAIL = 'distributor@supplyhubs.com';

var STATES = {
  NEW_TRANSACTION: 'new transaction',
  FINISHED: 'finished',
  HAS_ERROR: 'error',
};

var stripe = require('stripe')(secret.stripe.apiKey);

var server = new Hapi.Server();

server.connection({ port: 3000 });

server.register(require('inert'), function(err) {

  server.route({
    method: 'GET',
    path: '/',
    handler: function(request, reply) {
      reply.file(__dirname + '/checkout.html');
    },
  });

});

server.route({
  method: 'POST',
  path: '/checkout',
  config: {
    validate: {
      payload: {
        exp_month: Joi.number().min(1).max(12).required(),
        exp_year: Joi.number().min(new Date().getYear()).required(),
        cvc: Joi.string().required(),
        cc_number: Joi.string().required(),
      },
    },
  },
  handler: function(request, reply) {

    // look for already pending transactions on this cart
    var p = doQuery('MATCH (n:User {email: \'' + CURRENT_USER + '\' })'
      + '-[:HAS]->(cart:Cart)'
      + '<-[:PROCESSING]-(transaction:TransactionIn) RETURN transaction'
    );
    p.then(function(transaction) {
      reply('already processing').code(500);
    });

    p.catch(function(e) {
      if (e.message === 'Not Found') {
        return true;
      }

      throw e;
    }).then(function() {
      console.log('attempting transaction');
      return initializeTransaction(CURRENT_AMOUNT, CURRENT_CURRENCY, CURRENT_USER)
      .then(function(transaction) {
        return findOrCreateManagedAccount(transaction).then(function(account) {
          return doTransaction(request.payload, transaction, account);
        });
      });
    }).then(function(ret) {
      reply(JSON.stringify(ret, null, 2)).code(201);
    }).catch(function(e) {
      console.log(e.stack);
      reply(e.message).code(500);
    });
  },
});

server.start(function() {
  console.log('Server running at:', server.info.uri);
});

function initializeTransaction(amount, currency, email) {
  console.log('initializing transaction');

  var uid = unique();
  return doQuery(
    'CREATE (t:Transaction {'
      + 'unique : \'' + uid + '\','
      + 'state : \'' + STATES.NEW_TRANSACTION + '\','
      + 'amount : \'' + amount + '\','
      + 'currency : \'' + currency + '\','
      + 'user : \'' + email + '\''
    + '}) RETURN t'
  ).then(function(t) {
    return doQuery(
        'MATCH  (t:Transaction {unique:\'' + uid + '\'}),'
        + ' (u:User {email : \'' + email + '\'})-[:HAS]->(cart:Cart)'
        + ' CREATE (t)-[r:PROCESSING]->(cart)'
        + ' RETURN t'
    );
  }).then(function(ret) {
    return ret.t;
  });
}

function findOrCreateManagedAccount(transaction) {
  console.log('finding managed account', transaction);

  // Filter our Subcarts based on if they have a subtransaction pointing to the subcart or not
  return doQuery(
    'MATCH (:User {email: \'' + transaction.user + '\' })-[:HAS]->(:Cart)'
    + '<-[:PART_OF]-(:SubCart)<-[:IS_FULFILLER]-(distributor:Distributor)'
    + ' RETURN distributor'
  ).then(function(ret) {
    var distributor = ret.distributor;
    if (distributor.managedAccount) {
      return stripe.accounts.retrieve(distributor.managedAccount);
    }

    return stripe.accounts.create({
      managed: true,
      country: 'US',
      email: distributor.email || DISTRIBUTOR_EMAIL,
    }).then(function(account) {
      return doQuery('MATCH (n:Distributor) SET n.managedAccount = \'' + account.id + '\' RETURN n')
      .then(function(user) {
        console.log('done finding managed account');
        return account;
      });
    });
  });
}

function doTransaction(postdata, transaction, distributorAccount) {
  console.log('doing transaction');
  return stripe.charges.create({
    amount: Math.round(transaction.amount * 100), // amount in cents, again
    currency: transaction.currency,
    source: {
      exp_month: postdata.exp_month,
      exp_year: postdata.exp_year,
      number: postdata.cc_number,
      cvc: postdata.cvc,
      object: 'card',
    },
    application_fee: Math.ceil(transaction.amount * 100 * APPLICATION_FEE),
    destination: distributorAccount.id,
    description: 'Transaction[' + transaction.unique + '] for ' + transaction.user,
  }).then(function(charge) {
    console.log('saving transaction');
    return doQuery(
      'MATCH (t:Transaction {unique: \'' + transaction.unique + '\'})' +
      ' SET t.customerCharge = \'' + charge.id + '\', t.state = \'FINISHED\'' +
      ' RETURN t'
    ).then(function(ret) {
      return {
        payload: postdata,
        transaction: ret.t,
        charge: charge,
        distributor: distributorAccount,
      };
    });
  });
}
