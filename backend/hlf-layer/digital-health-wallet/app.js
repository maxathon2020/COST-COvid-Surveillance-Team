/**
 * Copyright 2017 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
'use strict';
var log4js = require('log4js');
var logger = log4js.getLogger('SampleWebApp');
var express = require('express');
var session = require('express-session');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var http = require('http');
var util = require('util');
var app = express();
var expressJWT = require('express-jwt');
var jwt = require('jsonwebtoken');
var bearerToken = require('express-bearer-token');
var cors = require('cors');
const {FileSystemWallet, X509WalletMixin, Gateway} = require('fabric-network')
const gateway = new Gateway()
var fs = require('fs')
var fileSystemPath = require('path')
var yaml = require('js-yaml')

require('./config.js');
var hfc = require('fabric-client');

var helper = require('./app/helper.js');
var createChannel = require('./app/create-channel.js');
var join = require('./app/join-channel.js');
var updateAnchorPeers = require('./app/update-anchor-peers.js');
var install = require('./app/install-chaincode.js');
var instantiate = require('./app/instantiate-chaincode.js');
var invoke = require('./app/invoke-transaction.js');
var query = require('./app/query.js');
var metadata = require('./metadata.js')
var host = process.env.HOST || hfc.getConfigSetting('host');
var port = process.env.PORT || hfc.getConfigSetting('port');

///////////////////////////////////////////////////////////////////////////////
//////////////////////////////// SET CONFIGURATONS ////////////////////////////
///////////////////////////////////////////////////////////////////////////////
app.options('*', cors());
app.use(cors());
//support parsing of application/json type post data
app.use(bodyParser.json());
//support parsing of application/x-www-form-urlencoded post data
app.use(bodyParser.urlencoded({
	extended: false
}));
//set secret variable
app.set('secret', 'thisismysecret');
app.use(expressJWT({
	secret: 'thisismysecret'
}).unless({
	path: ['/users']
}));
app.use(bearerToken());
app.use(function(req, res, next) {
	logger.debug(' ------>>>>>> new request for %s',req.originalUrl);
	if (req.originalUrl.indexOf('/users') >= 0) {
		return next();
	}

	var token = req.token;
	jwt.verify(token, app.get('secret'), function(err, decoded) {
		if (err) {
			res.send({
				success: false,
				message: 'Failed to authenticate token. Make sure to include the ' +
					'token returned from /users call in the authorization header ' +
					' as a Bearer token'
			});
			return;
		} else {
			// add the decoded user name and org name to the request object
			// for the downstream code to use
			req.username = decoded.username;
			req.orgname = decoded.orgName;
			logger.debug(util.format('Decoded from JWT token: username - %s, orgname - %s', decoded.username, decoded.orgName));
			return next();
		}
	});
});

///////////////////////////////////////////////////////////////////////////////
//////////////////////////////// START SERVER /////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
var server = http.createServer(app).listen(port, function() {});
logger.info('****************** SERVER STARTED ************************');
logger.info('***************  http://%s:%s  ******************',host,port);
server.timeout = 240000;

function getErrorMessage(field) {
	var response = {
		success: false,
		message: field + ' field is missing or Invalid in the request'
	};
	return response;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////// REST ENDPOINTS START HERE ///////////////////////////
///////////////////////////////////////////////////////////////////////////////
// Register and enroll user
app.post('/users', async function(req, res) {
	var username = req.body.username;
	var orgName = req.body.orgName;
	logger.debug('End point : /users');
	logger.debug('User name : ' + username);
	logger.debug('Org name  : ' + orgName);
	if (!username) {
		res.json(getErrorMessage('\'username\''));
		return;
	}
	if (!orgName) {
		res.json(getErrorMessage('\'orgName\''));
		return;
	}
	var token = jwt.sign({
		exp: Math.floor(Date.now() / 1000) + parseInt(hfc.getConfigSetting('jwt_expiretime')),
		username: username,
		orgName: orgName
	}, app.get('secret'));
	let response = await helper.getRegisteredUser(username, orgName, true);
	logger.debug('-- returned from registering the username %s for organization %s',username,orgName);
	if (response && typeof response !== 'string') {
		logger.debug('Successfully registered the username %s for organization %s',username,orgName);
		response.token = token;
		res.json(response);
	} else {
		logger.debug('Failed to register the username %s for organization %s with::%s',username,orgName,response);
		res.json({success: false, message: response});
	}

});
// Create Channel
app.post('/channels', async function(req, res) {
	logger.info('<<<<<<<<<<<<<<<<< C R E A T E  C H A N N E L >>>>>>>>>>>>>>>>>');
	logger.debug('End point : /channels');
	var channelName = req.body.channelName;
	var channelConfigPath = req.body.channelConfigPath;
	logger.debug('Channel name : ' + channelName);
	logger.debug('channelConfigPath : ' + channelConfigPath); //../artifacts/channel/mychannel.tx
	if (!channelName) {
		res.json(getErrorMessage('\'channelName\''));
		return;
	}
	if (!channelConfigPath) {
		res.json(getErrorMessage('\'channelConfigPath\''));
		return;
	}

	let message = await createChannel.createChannel(channelName, channelConfigPath, req.username, req.orgname);
	res.send(message);
});
// Join Channel
app.post('/channels/:channelName/peers', async function(req, res) {
	logger.info('<<<<<<<<<<<<<<<<< J O I N  C H A N N E L >>>>>>>>>>>>>>>>>');
	var channelName = req.params.channelName;
	var peers = req.body.peers;
	logger.debug('channelName : ' + channelName);
	logger.debug('peers : ' + peers);
	logger.debug('username :' + req.username);
	logger.debug('orgname:' + req.orgname);

	if (!channelName) {
		res.json(getErrorMessage('\'channelName\''));
		return;
	}
	if (!peers || peers.length == 0) {
		res.json(getErrorMessage('\'peers\''));
		return;
	}

	let message =  await join.joinChannel(channelName, peers, req.username, req.orgname);
	res.send(message);
});
// Update anchor peers
app.post('/channels/:channelName/anchorpeers', async function(req, res) {
	logger.debug('==================== UPDATE ANCHOR PEERS ==================');
	var channelName = req.params.channelName;
	var configUpdatePath = req.body.configUpdatePath;
	logger.debug('Channel name : ' + channelName);
	logger.debug('configUpdatePath : ' + configUpdatePath);
	if (!channelName) {
		res.json(getErrorMessage('\'channelName\''));
		return;
	}
	if (!configUpdatePath) {
		res.json(getErrorMessage('\'configUpdatePath\''));
		return;
	}

	let message = await updateAnchorPeers.updateAnchorPeers(channelName, configUpdatePath, req.username, req.orgname);
	res.send(message);
});
// Install chaincode on target peers
app.post('/chaincodes', async function(req, res) {
	logger.debug('==================== INSTALL CHAINCODE ==================');
	var peers = req.body.peers;
	var chaincodeName = req.body.chaincodeName;
	var chaincodePath = req.body.chaincodePath;
	var chaincodeVersion = req.body.chaincodeVersion;
	var chaincodeType = req.body.chaincodeType;
	logger.debug('peers : ' + peers); // target peers list
	logger.debug('chaincodeName : ' + chaincodeName);
	logger.debug('chaincodePath  : ' + chaincodePath);
	logger.debug('chaincodeVersion  : ' + chaincodeVersion);
	logger.debug('chaincodeType  : ' + chaincodeType);
	if (!peers || peers.length == 0) {
		res.json(getErrorMessage('\'peers\''));
		return;
	}
	if (!chaincodeName) {
		res.json(getErrorMessage('\'chaincodeName\''));
		return;
	}
	if (!chaincodePath) {
		res.json(getErrorMessage('\'chaincodePath\''));
		return;
	}
	if (!chaincodeVersion) {
		res.json(getErrorMessage('\'chaincodeVersion\''));
		return;
	}
	if (!chaincodeType) {
		res.json(getErrorMessage('\'chaincodeType\''));
		return;
	}
	let message = await install.installChaincode(peers, chaincodeName, chaincodePath, chaincodeVersion, chaincodeType, req.username, req.orgname)
	res.send(message)
});
// Instantiate chaincode on target peers
app.post('/channels/:channelName/chaincodes', async function(req, res) {
	logger.debug('==================== INSTANTIATE CHAINCODE ==================');
	var peers = req.body.peers;
	var chaincodeName = req.body.chaincodeName;
	var chaincodeVersion = req.body.chaincodeVersion;
	var channelName = req.params.channelName;
	var chaincodeType = req.body.chaincodeType;
	var fcn = req.body.fcn;
	var args = req.body.args;
	logger.debug('peers  : ' + peers);
	logger.debug('channelName  : ' + channelName);
	logger.debug('chaincodeName : ' + chaincodeName);
	logger.debug('chaincodeVersion  : ' + chaincodeVersion);
	logger.debug('chaincodeType  : ' + chaincodeType);
	logger.debug('fcn  : ' + fcn);
	logger.debug('args  : ' + args);
	if (!chaincodeName) {
		res.json(getErrorMessage('\'chaincodeName\''));
		return;
	}
	if (!chaincodeVersion) {
		res.json(getErrorMessage('\'chaincodeVersion\''));
		return;
	}
	if (!channelName) {
		res.json(getErrorMessage('\'channelName\''));
		return;
	}
	if (!chaincodeType) {
		res.json(getErrorMessage('\'chaincodeType\''));
		return;
	}
	if (!args) {
		res.json(getErrorMessage('\'args\''));
		return;
	}

	let message = await instantiate.instantiateChaincode(peers, channelName, chaincodeName, chaincodeVersion, chaincodeType, fcn, args, req.username, req.orgname);
	res.send(message);
});
// Invoke transaction on chaincode on target peers
var convertArgs = async function(args, token, funcCallback, key, ...rest){
	console.log(typeof args)
	var imageURL = args[args.length-1]
	return metadata.extractMetadata(args, imageURL, funcCallback, key, rest)
}
app.post('/channels/:channelName/chaincodes/:chaincodeName', async function(req, res) {
	logger.debug('==================== INVOKE ON CHAINCODE ==================');
	var peers = req.body.peers;
	var chaincodeName = req.params.chaincodeName;
	var channelName = req.params.channelName;
	var fcn = req.body.fcn;
	var args = req.body.args;
	var type = req.query.type;
	var key = req.query .key
	logger.debug('channelName  : ' + channelName);
	logger.debug('chaincodeName : ' + chaincodeName);
	logger.debug('fcn  : ' + fcn);
	logger.debug('args  : ' + args);
	if (!chaincodeName) {
		res.json(getErrorMessage('\'chaincodeName\''));
		return;
	}
	if (!channelName) {
		res.json(getErrorMessage('\'channelName\''));
		return;
	}
	if (!fcn) {
		res.json(getErrorMessage('\'fcn\''));
		return;
	}
	if (!args) {
		res.json(getErrorMessage('\'args\''));
		return;
	}
	if(type === 'uploadData'){
		await convertArgs(args, req.headers.authorization.toString(), invoke.invokeChaincode, key, peers, channelName, chaincodeName, fcn, req.username, req.orgname, res)
	}
	else {
		let message = await invoke.invokeChaincode(peers, channelName, chaincodeName, fcn, args, req.username, req.orgname)
		res.send(message)
	}

});

// Invoke private data set
app.post('/channels/:channelName/chaincodes/:chaincodeName/privateData', async function(req, res) {
	logger.debug('==================== INVOKE ON PRIVATEDATA ==================')
	var channelName = req.params.channelName
	var chaincodeName = req.params.chaincodeName
	var fcn = req.body.fcn
	var args = req.body.args
	var peers = req.body.peers

	logger.debug('channelName : ' + channelName)
	logger.debug('chaincodeName : ' + chaincodeName)
	logger.debug('fcn : ' + fcn)
	logger.debug('collectionName : ' + args[1])
	logger.debug('args : ' + args)
	if (!chaincodeName) {
		res.json(getErrorMessage('\'chaincodeName\''));
		return;
	}
	if (!channelName) {
		res.json(getErrorMessage('\'channelName\''));
		return;
	}
	if (!fcn) {
		res.json(getErrorMessage('\'fcn\''));
		return;
	}
	if (!args) {
		res.json(getErrorMessage('\'args\''));
		return;
	}
	
	let message = await invoke.invokeChaincode(peers, channelName, chaincodeName, fcn, args, req.username, req.orgname)
	res.send(message)

})
// Query on chaincode on target peers
app.get('/channels/:channelName/chaincodes/:chaincodeName', async function(req, res) {
	logger.debug('==================== QUERY BY CHAINCODE ==================');
	var channelName = req.params.channelName;
	var chaincodeName = req.params.chaincodeName;
	var type = req.query.type
	let args = req.query.args;
	let fcn = req.query.fcn;
	let peer = req.query.peer;
	var key = req.query.key;

	logger.debug('channelName : ' + channelName);
	logger.debug('chaincodeName : ' + chaincodeName);
	logger.debug('fcn : ' + fcn);
	logger.debug('args : ' + args);

	if (!chaincodeName) {
		res.json(getErrorMessage('\'chaincodeName\''));
		return;
	}
	if (!channelName) {
		res.json(getErrorMessage('\'channelName\''));
		return;
	}
	if (!fcn) {
		res.json(getErrorMessage('\'fcn\''));
		return;
	}
	if (!args) {
		res.json(getErrorMessage('\'args\''));
		return;
	}
	args = args.replace(/'/g, '"');
	args = JSON.parse(args);
	logger.debug(args);

	let message = await query.queryChaincode(peer, channelName, chaincodeName, args, fcn, req.username, req.orgname);
	var fileURL;
	if(type === 'decrypt' && fcn === 'queryAsset'){
		var val = JSON.parse(message)
		let jsonKeys
		try{
			if(Array.isArray(val)){
				for(var i in val){
					jsonKeys = getKeys(val[i])
					i.push(jsonKeys)
				}
			}
			else{
				var keyValue = Object.keys(val)
				for(var i in keyValue){
					if(keyValue[i].includes('ENCRYPT')){
							try{
								var x = metadata.decryptMetadata(val[keyValue[i]], key)
								var st = keyValue[i] + "_DECRYPT"
								val[st] = JSON.parse(x)
								
							}catch(error){
								console.log("Unable to parse json")
								console.log(error)
								continue
							}
					}
					if(keyValue[i].includes['URL']){
						fileURL = val[keyValue[i]]
					}
				}
			}
		}catch(error){
			logger.error('Something went wrong')
			logger.error('Verify the request for correct format')
			logger.error(error)
		}

		// console.log('--------------------------------------------')
		// console.log(val)
		// console.log('--------------------------------------------')
		await metadata.verify(res, val, key)

	}
	else{
		res.send(message)
	}
});
const getKeys = function(jsonObj){
	var ret;
	var keys = Object.keys(jsonObj)
	var val
	for(var i in keys){
		if(keys[i].includes('ENCRYPT') || keys[i].includes('HASH')){
			val = metadata.decryptMetadata(jsonObj[keys[i]])
			var st = keys[i] + (keys[i].includes('ENCRYPT') ? "_DECRYPT" : "MARSHAL")
			ret[st] = val
		}
	}
	return ret;
}
// Upgrade chaincode
app.post('/channels/:channelName/chaincode/:chaincodeName/upgrade', async function(req, res) {
	logger.debug('==================== Upgrade Chaincode ==================')
	var channelName = req.params.channelName
	var chaincodeName = req.params.chaincodeName
	let args = req.body.args
	let chaincodeVersion = req.body.chaincodeVersion
	let chaincodeType = req.body.chaincodeType
	let peers = req.body.peers
	let fcn = req.body.fcn

	if(!channelName){
		res.json(getErrorMessage('\'channelName\''))
		return
	}
	if(!chaincodeName){
		res.json(getErrorMessage('\'chaincodeName\''))
	}
	if(!chaincodeType){
		res.json(getErrorMessage('\'chaincodeType\''))
	}
	if(!chaincodeVersion){
		res.json(getErrorMessage('\'chaincodeVersion\''))
	}
	let message = await instantiate.upgradeChaincode(peers, channelName, chaincodeName, chaincodeVersion, chaincodeType, args, fcn, req.username, req.orgname)
	res.send(message)

})

//  Query Get Block by BlockNumber
app.get('/channels/:channelName/blocks/:blockId', async function(req, res) {
	logger.debug('==================== GET BLOCK BY NUMBER ==================');
	let blockId = req.params.blockId;
	let peer = req.query.peer;
	logger.debug('channelName : ' + req.params.channelName);
	logger.debug('BlockID : ' + blockId);
	logger.debug('Peer : ' + peer);
	if (!blockId) {
		res.json(getErrorMessage('\'blockId\''));
		return;
	}

	let message = await query.getBlockByNumber(peer, req.params.channelName, blockId, req.username, req.orgname);
	res.send(message);
});
// Query Get Transaction by Transaction ID
app.get('/channels/:channelName/transactions/:trxnId', async function(req, res) {
	logger.debug('================ GET TRANSACTION BY TRANSACTION_ID ======================');
	logger.debug('channelName : ' + req.params.channelName);
	let trxnId = req.params.trxnId;
	let peer = req.query.peer;
	if (!trxnId) {
		res.json(getErrorMessage('\'trxnId\''));
		return;
	}

	let message = await query.getTransactionByID(peer, req.params.channelName, trxnId, req.username, req.orgname);
	res.send(message);
});
// Query Get Block by Hash
app.get('/channels/:channelName/blocks', async function(req, res) {
	logger.debug('================ GET BLOCK BY HASH ======================');
	logger.debug('channelName : ' + req.params.channelName);
	let hash = req.query.hash;
	let peer = req.query.peer;
	if (!hash) {
		res.json(getErrorMessage('\'hash\''));
		return;
	}

	let message = await query.getBlockByHash(peer, req.params.channelName, hash, req.username, req.orgname);
	res.send(message);
});
//Query for Channel Information
app.get('/channels/:channelName', async function(req, res) {
	logger.debug('================ GET CHANNEL INFORMATION ======================');
	logger.debug('channelName : ' + req.params.channelName);
	let peer = req.query.peer;

	let message = await query.getChainInfo(peer, req.params.channelName, req.username, req.orgname);
	res.send(message);
});
//Query for Channel instantiated chaincodes
app.get('/channels/:channelName/chaincodes', async function(req, res) {
	logger.debug('================ GET INSTANTIATED CHAINCODES ======================');
	logger.debug('channelName : ' + req.params.channelName);
	let peer = req.query.peer;

	let message = await query.getInstalledChaincodes(peer, req.params.channelName, 'instantiated', req.username, req.orgname);
	res.send(message);
});
// Query to fetch all Installed/instantiated chaincodes
app.get('/chaincodes', async function(req, res) {
	var peer = req.query.peer;
	var installType = req.query.type;
	logger.debug('================ GET INSTALLED CHAINCODES ======================');

	let message = await query.getInstalledChaincodes(peer, null, 'installed', req.username, req.orgname)
	res.send(message);
});
// Query to fetch channels
app.get('/channels', async function(req, res) {
	logger.debug('================ GET CHANNELS ======================');
	logger.debug('peer: ' + req.query.peer);
	var peer = req.query.peer;
	if (!peer) {
		res.json(getErrorMessage('\'peer\''));
		return;
	}

	let message = await query.getChannels(peer, req.username, req.orgname);
	res.send(message);
});


app.post('/channels/:channelName/wallet/:username', async function(req, res) {
	logger.debug('==============Initialising Wallet===========================')
	let path = req.body.path
	let username = req.params.username
	let orgName = req.body.orgName

	if(fs.existsSync(path)){
		res.send({'Message': 'Wallet already present', 'Path': path})
	}
	else {
		const wallet = new FileSystemWallet(path)
		const identityLabel = username.toLowerCase() + '@' + orgName + '.example.com'
		const hlfUserName = 'User1@' + orgName + '.example.com'
		

		try{
			const credPath = fileSystemPath.join(__dirname, './crypto-config/peerOrganizations/'+ orgName +'.example.com/users/' + hlfUserName)
			const keystoreBasePath = fileSystemPath.join(credPath, '/msp/keystore/')

			var files = fs.readdirSync(keystoreBasePath)
			
			if(files.length > 1){
				throw new Error('Directory is corrupt.')
			}

			const cert = fs.readFileSync(fileSystemPath.join(credPath,'/msp/signcerts/' + hlfUserName + '-cert.pem')).toString()
			const key = fs.readFileSync(fileSystemPath.join(credPath, '/msp/keystore/'+files[0])).toString()

			const identity = X509WalletMixin.createIdentity(orgName + 'MSP', cert, key)

			let message = await wallet.import(identityLabel, identity)

			let connProfile = yaml.safeLoad(fs.readFileSync(fileSystemPath.join(__dirname,'/artifacts/network-config.yaml'), 'utf-8'))


			await gateway.connect(connProfile, { wallet, identity: identityLabel, discovery: { enabled: true, asLocalhost: false } });
			const client = gateway.getClient();
			const userTlsCert = await wallet.export(identityLabel);
			client.setTlsClientCertAndKey(userTlsCert.certificate, userTlsCert.privateKey);
			logger.debug(userTlsCert)

			res.send({'Message': 'Wallet successfully created', 'Path': path})
		} catch(error){
			logger.debug('Error initialising the wallet')
			logger.debug(error.message)
			var handle = {
				'Message': 'Unable to find the path specified',
				'Path': path
			}
			res.status(404).json(handle)
		}
	}

})

app.post('/channels/:channelName/wallet/:username/invoke', async function(req, res) {
	logger.debug('==========Invoking Chaincode using wallet===================')

	let path = req.body.path
	let username = req.params.username
	let orgname = req.body.orgName
	let channelName = req.params.channelName
	let chaincodeName = req.body.chaincodeName

	const u =  username.toLowerCase() + '@' + orgname + '.example.com'
	let wallet
	let connProfile = yaml.safeLoad(fs.readFileSync(fileSystemPath.join(__dirname,'/artifacts/network-config.yaml'), 'utf-8'))
	try{
		 wallet = new FileSystemWallet(path)
	}
	catch(err){
		logger.error("User is not enrolled or invalid path provided")
		var handle = {
			'Message': "User is not enrolled or Invalid path provided",
			'Path': path,
			'UserName': u
		}
		res.status(400).json(handle)
	}
	
	let connOptions = {
		identity: u,
		wallet: wallet,
		discovery: {enabled:false, asLocalhost:true}
	}

	try{
		await gateway.connect(connProfile, connOptions)

		const client = gateway.getClient().setTlsClientCertAndKey
	
		const network = await gateway.getNetwork(channelName)
	
		const contract = network.getContract(chaincodeName)
	
		const resp = await contract.submitTransaction('invokeTest', 'invokeTest')
	
		logger.debug('-----------',resp)
	
		res.send(resp)
	}
	catch(err){
		logger.error("Unable to invoke the chaincode")
		var handle = {
			'Message': "Unable to invoke the chaincode",
			'Path': path,
			'UserName': u,
			'ChaincodeName': chaincodeName,
			'Channel': channelName
		}
		res.status(400).json(handle)
	}
})