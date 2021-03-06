const START = Date.now();
const argv = require('minimist')(process.argv.slice(2));
const Nimiq = require('../../dist/node.js');
const JsonRpcServer = require('./modules/JsonRpcServer.js');
const UiServer = require('./modules/UiServer.js');
const MetricsServer = require('./modules/MetricsServer.js');
const config = require('./modules/Config.js')(argv);
const openBrowserTab = require('./modules/NodeUtils.js').openBrowserTab;

// Deprecated dumb config flag.
if (config.dumb) {
    console.error(`The '--dumb' flag is deprecated, use '--protocol=dumb' instead.`);
    config.protocol = 'dumb';
}

if ((config.protocol === 'wss' && !(config.host && config.port && config.tls && config.tls.cert && config.tls.key)) ||
    (config.protocol === 'ws' && !(config.host && config.port)) ||
    argv.help) {
    console.log(
        'Nimiq NodeJS client\n' +
        '\n' +
        'Usage:\n' +
        '    node index.js --config=CONFIG [options]\n' +
        '    node index.js --host=HOSTNAME --port=PORT --cert=SSL_CERT_FILE --key=SSL_KEY_FILE [options]\n' +
        '    node index.js --host=HOSTNAME --port=PORT --protocol=ws [options]\n' +
        '\n' +
        'Configuration:\n' +
        '  --cert=SSL_CERT_FILE       Certificate file to use. CN should match HOSTNAME.\n' +
        '  --host=HOSTNAME            Configure hostname.\n' +
        '  --key=SSL_KEY_FILE         Private key file to use.\n' +
        '  --port=PORT                Specifies which port to listen on for connections.\n' +
        '  --protocol=TYPE            Set up the protocol to be used. Available protocols are\n' +
        '                              - wss: WebSocket Secure, requires a FQDN, port,\n' +
        '                                     and SSL certificate\n' +
        '                              - ws: WebSocket, only requires public IP/FQDN and port\n' +
        '                              - dumb: discouraged as the number of dumb nodes might\n' +
        '                                      be limited\n' +
        '\n' +
        'Options:\n' +
        '  --help                     Show this usage instructions.\n' +
        '  --log[=LEVEL]              Configure global log level. Not specifying a log\n' +
        '                             level will enable verbose log output.\n' +
        '  --log-tag=TAG[:LEVEL]      Configure log level for a specific tag.\n' +
        '  --miner[=THREADS]          Activate mining on this node. The miner will be set\n' +
        '                             up to use THREADS parallel threads.\n' +
        '  --pool=SERVER:PORT         Mine shares for mining pool with address SERVER:PORT\n' +
        '  --device-data=DATA_JSON    Pass information about this device to the pool. Takes a\n' +
        '                             valid JSON string. Only used when registering for a pool.\n' +
        '  --passive                  Do not actively connect to the network and do not\n' +
        '                             wait for connection establishment.\n' +
        '  --rpc[=PORT]               Start JSON-RPC server on port PORT (default: 8648).\n' +
        '  --metrics[=PORT]           Start Prometheus-compatible metrics server on port\n' +
        '           [:PASSWORD]       PORT (default: 8649). If PASSWORD is specified, it\n' +
        '                             is required to be used for username "metrics" via\n' +
        '                             Basic Authentication.\n' +
        '  --ui[=PORT]                Serve a miner UI on port PORT (default: 8650).\n' +
        '  --statistics[=INTERVAL]    Output statistics like mining hashrate, current\n' +
        '                             account balance and mempool size every INTERVAL\n' +
        '                             seconds.\n' +
        '  --type=TYPE                Configure the consensus type to establish, one of\n' +
        '                             full (default), light, or nano.\n' +
        '  --reverse-proxy[=PORT]     This client is behind a reverse proxy running on PORT,IP\n' +
        '                 [,IP]       (default: 8444,::ffff:127.0.0.1).\n' +
        '  --wallet-seed=SEED         Initialize wallet using SEED as a wallet seed.\n' +
        '  --wallet-address=ADDRESS   Initialize wallet using ADDRESS as a wallet address\n' +
        '                             The wallet cannot be used to sign transactions when\n' +
        '                             using this option.\n' +
        '  --extra-data=EXTRA_DATA    Extra data to add to every mined block.\n' +
        '  --network=NAME             Configure the network to connect to, one of\n' +
        '                             main (default), test, dev, or bounty.\n');

    process.exit();
}

const isNano = config.type === 'nano';

if (isNano && config.miner.enabled) {
    console.error('Cannot mine when running as a nano client');
    process.exit(1);
}
if (config.metricsServer.enabled && config.protocol !== 'wss') {
    console.error('Cannot provide metrics when running as without a certificate');
    process.exit(1);
}
if (config.metricsServer.enabled && isNano) {
    console.error('Cannot provide metrics when running as a nano client');
    process.exit(1);
}
if ((isNano || config.poolMining.mode === 'nano') && config.uiServer.enabled) {
    console.error('The UI is currently not supported for nano clients');
    process.exit(1);
}
if (!Nimiq.GenesisConfig.CONFIGS[config.network]) {
    console.error(`Invalid network name: ${config.network}`);
    process.exit(1);
}
if (config.wallet.seed && config.wallet.address) {
    console.error('Cannot use both --wallet-seed and --wallet-address');
    process.exit(1);
}
if (config.host && config.protocol === 'dumb') {
    console.error('Cannot use both --host and --protocol=dumb');
    process.exit(1);
}
if (config.reverseProxy.enabled && config.protocol === 'dumb') {
    console.error('Cannot run a dumb client behind a reverse proxy');
    process.exit(1);
}
if (config.type === 'light') {
    console.error('Light node type is temporarily disabled');
    process.exit(1);
}

Nimiq.Log.instance.level = config.log.level;
for (const tag in config.log.tags) {
    Nimiq.Log.instance.setLoggable(tag, config.log.tags[tag]);
}

for (const key in config.constantOverrides) {
    Nimiq.ConstantHelper.instance.set(key, config.constantOverrides[key]);
}

for (const seedPeer of config.seedPeers) {
    if (!seedPeer.host || !seedPeer.port) {
        console.error('Seed peers must have host and port attributes set');
        process.exit(1);
    }
}

const TAG = 'Node';
const $ = {};

(async () => {
    if (config.protocol === 'dumb') {
        Nimiq.Log.e(TAG, `******************************************************************************`);
        Nimiq.Log.e(TAG, `*                                                                            *`);
        Nimiq.Log.e(TAG, `*  You are running in 'dumb' configuration, so others can't connect to you.  *`);
        Nimiq.Log.e(TAG, `*  Consider switching to a proper WebSocket/WebSocketSecure configuration.   *`);
        Nimiq.Log.e(TAG, `*                                                                            *`);
        Nimiq.Log.e(TAG, `******************************************************************************`);
    }

    Nimiq.Log.i(TAG, `Nimiq NodeJS Client starting (network=${config.network}`
        + `, ${config.host ? `host=${config.host}, port=${config.port}` : 'dumb'}`
        + `, miner=${config.miner.enabled}, rpc=${config.rpcServer.enabled}${config.rpcServer.enabled ? `@${config.rpcServer.port}` : ''}`
        + `, ui=${config.uiServer.enabled}${config.uiServer.enabled? `@${config.uiServer.port}` : ''}`
        + `, metrics=${config.metricsServer.enabled}${config.metricsServer.enabled ? `@${config.metricsServer.port}` : ''})`);

    Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);

    for (const seedPeer of config.seedPeers) {
        let address;
        switch (seedPeer.protocol) {
            case 'ws':
                address = Nimiq.WsPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey);
                break;
            case 'wss':
            default:
                address = Nimiq.WssPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey);
                break;
        }
        Nimiq.GenesisConfig.SEED_PEERS.push(address);
    }

    let networkConfig;
    switch (config.protocol) {
        case 'wss':
            networkConfig = new Nimiq.WssNetworkConfig(config.host, config.port, config.tls.key, config.tls.cert, config.reverseProxy);
            break;
        case 'ws':
            networkConfig = new Nimiq.WsNetworkConfig(config.host, config.port, config.reverseProxy);
            break;
        case 'dumb':
            networkConfig = new Nimiq.DumbNetworkConfig();
            break;
    }

    switch (config.type) {
        case 'full':
            $.consensus = await Nimiq.Consensus.full(networkConfig);
            break;
        case 'light':
            $.consensus = await Nimiq.Consensus.light(networkConfig);
            break;
        case 'nano':
            $.consensus = await Nimiq.Consensus.nano(networkConfig);
            break;
    }

    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    Nimiq.Log.i(TAG, `Peer address: ${networkConfig.peerAddress.toString()} - public key: ${networkConfig.keyPair.publicKey.toHex()}`);

    // TODO: Wallet key.
    $.walletStore = await new Nimiq.WalletStore();
    if (!config.wallet.address && !config.wallet.seed) {
        // Load or create default wallet.
        $.wallet = await $.walletStore.getDefault();
    } else if (config.wallet.seed) {
        // Load wallet from seed.
        const mainWallet = Nimiq.Wallet.loadPlain(config.wallet.seed);
        await $.walletStore.put(mainWallet);
        await $.walletStore.setDefault(mainWallet.address);
        $.wallet = mainWallet;
    } else {
        const address = Nimiq.Address.fromUserFriendlyAddress(config.wallet.address);
        $.wallet = {address: address};
        // Check if we have a full wallet in store.
        const wallet = await $.walletStore.get(address);
        if (wallet) {
            $.wallet = wallet;
            await $.walletStore.setDefault(wallet.address);
        }
    }

    const addresses = await $.walletStore.list();
    Nimiq.Log.i(TAG, `Managing wallets [${addresses.map(address => address.toUserFriendlyAddress())}]`);

    const account = !isNano ? await $.accounts.get($.wallet.address) : null;
    Nimiq.Log.i(TAG, `Wallet initialized for address ${$.wallet.address.toUserFriendlyAddress()}.`
        + (!isNano ? ` Balance: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM` : ''));

    Nimiq.Log.i(TAG, `Blockchain state: height=${$.blockchain.height}, headHash=${$.blockchain.headHash}`);

    const extraData = config.miner.extraData ? Nimiq.BufferUtils.fromAscii(config.miner.extraData) : new Uint8Array(0);
    if (config.poolMining.enabled || config.uiServer.enabled) { // ui requires SmartPoolMiner to be able to switch
        // between solo mining and pool mining
        const deviceId = Nimiq.BasePoolMiner.generateDeviceId(networkConfig);
        const deviceData = config.poolMining.deviceData;
        const poolMode = isNano ? 'nano' : config.poolMining.mode;
        switch (poolMode) {
            case 'nano':
                $.miner = new Nimiq.NanoPoolMiner($.blockchain, $.network.time, $.wallet.address, deviceId, deviceData);
                break;
            case 'smart':
            default:
                $.miner = new Nimiq.SmartPoolMiner($.blockchain, $.accounts, $.mempool, $.network.time, $.wallet.address, deviceId, deviceData, extraData);
                break;
        }
        $.consensus.on('established', () => {
            if (!config.poolMining.enabled || !$.miner.isDisconnected()) return;
            if (!config.poolMining.host || config.poolMining.port === -1) {
                Nimiq.Log.i(TAG, 'Not connecting to pool as mining pool host or port were not specified.');
                return;
            }
            Nimiq.Log.i(TAG, `Connecting to pool ${config.poolMining.host} using device id ${deviceId} as a ${poolMode} client.`);
            $.miner.connect(config.poolMining.host, config.poolMining.port);
        });
    } else {
        $.miner = new Nimiq.Miner($.blockchain, $.accounts, $.mempool, $.network.time, $.wallet.address, extraData);
    }

    $.blockchain.on('head-changed', (head) => {
        if ($.consensus.established || head.height % 100 === 0) {
            Nimiq.Log.i(TAG, `Now at block: ${head.height}`);
        }
    });

    $.network.on('peer-joined', (peer) => {
        Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });
    $.network.on('peer-left', (peer) => {
        Nimiq.Log.i(TAG, `Disconnected from ${peer.peerAddress.toString()}`);
    });

    const isSeed = (peerAddress) => Nimiq.GenesisConfig.SEED_PEERS.some(seed => seed.equals(peerAddress));
    $.network.on('peer-joined', (peer) => {
        if (Math.abs(peer.timeOffset) > Nimiq.Network.TIME_OFFSET_MAX && isSeed(peer.peerAddress)) {
            Nimiq.Log.e(TAG, 'Your local system time seems to be wrong! You might not be able to synchronize with the network.');
        }
    });

    if (!config.passive) {
        $.network.connect();
    }

    if (config.miner.enabled && config.passive) {
        $.miner.startWork();
    }
    $.consensus.on('established', () => {
        if (config.miner.enabled) $.miner.startWork();
    });
    $.consensus.on('lost', () => {
        if (!config.poolMining.enabled || config.poolMining.mode !== 'nano') $.miner.stopWork()
    });

    if (typeof config.miner.threads === 'number') {
        $.miner.threads = config.miner.threads;
    }
    $.miner.throttleAfter = config.miner.throttleAfter;
    $.miner.throttleWait = config.miner.throttleWait;

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `Blockchain ${config.type}-consensus established in ${(Date.now() - START) / 1000}s.`);
        Nimiq.Log.i(TAG, `Current state: height=${$.blockchain.height}, totalWork=${$.blockchain.totalWork}, headHash=${$.blockchain.headHash}`);
    });

    $.miner.on('block-mined', (block) => {
        Nimiq.Log.i(TAG, `Block mined: #${block.header.height}, hash=${block.header.hash()}`);
    });

    if (config.statistics > 0) {
        // Output regular statistics
        const hashrates = [];
        const outputInterval = config.statistics;

        $.miner.on('hashrate-changed', async (hashrate) => {
            hashrates.push(hashrate);

            if (hashrates.length >= outputInterval) {
                const account = !isNano ? await $.accounts.get($.wallet.address) : null;
                const sum = hashrates.reduce((acc, val) => acc + val, 0);
                Nimiq.Log.i(TAG, `Hashrate: ${(sum / hashrates.length).toFixed(2).padStart(7)} H/s`
                    + (!isNano ? ` - Balance: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM` : '')
                    + (config.poolMining.enabled ? ` - Pool balance: ${Nimiq.Policy.satoshisToCoins($.miner.balance)} NIM (confirmed ${Nimiq.Policy.satoshisToCoins($.miner.confirmedBalance)} NIM)` : '')
                    + ` - Mempool: ${$.mempool.getTransactions().length} tx`);
                hashrates.length = 0;
            }
        });
    }

    if (config.rpcServer.enabled || config.uiServer.enabled) {
        // Add CORS domain for UI.
        if (config.uiServer.enabled) {
            config.rpcServer.corsdomain = typeof config.rpcServer.corsdomain === 'string'
                ? [config.rpcServer.corsdomain]
                : (config.rpcServer.corsdomain || []);
            config.rpcServer.corsdomain.push(`http://localhost:${config.uiServer.port}`);
        }

        // Use restricted set of RPC functions for UI.
        if (!config.rpcServer.enabled) {
            config.rpcServer.methods = [
                'consensus',
                'blockNumber',
                'getBlockByNumber',
                'peerCount',
                'mining',
                'minerThreads',
                'minerAddress',
                'hashrate',
                'pool',
                'poolConnectionState',
                'poolConfirmedBalance',
                'getAccount'
            ];
        }

        $.rpcServer = new JsonRpcServer(config.rpcServer, config.miner, config.poolMining);
        $.rpcServer.init($.consensus, $.blockchain, $.accounts, $.mempool, $.network, $.miner, $.walletStore);
    }

    if (config.metricsServer.enabled) {
        $.metricsServer = new MetricsServer(networkConfig.sslConfig, config.metricsServer.port, config.metricsServer.password);
        $.metricsServer.init($.blockchain, $.accounts, $.mempool, $.network, $.miner);
    }

    if (config.uiServer.enabled) {
        $.uiServer = new UiServer(config.uiServer);
        openBrowserTab(`http://localhost:${config.uiServer.port}#port=${config.rpcServer.port}`, () => {
            Nimiq.Log.w(TAG, 'Failed to automatically open the UI in your web browser.');
            Nimiq.Log.w(TAG, `Go to http://localhost:${config.uiServer.port}#port=${config.rpcServer.port} to access it.`);
        });
    }
})().catch(e => {
    console.error(e);
    process.exit(1);
});
