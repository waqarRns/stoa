import { Block, Endian, Hash, hash, hashFull, Height, PreImageInfo, Transaction, Utils } from "boa-sdk-ts";
import { cors_options } from "./cors";
import { AgoraClient } from "./modules/agora/AgoraClient";
import { IDatabaseConfig } from "./modules/common/Config";
import { FeeManager } from "./modules/common/FeeManager";
import { HeightManager } from "./modules/common/HeightManager";
import { Logger, logger } from "./modules/common/Logger";
import { Operation } from "./modules/common/LogOperation";
import { Time } from "./modules/common/Time";
import { CoinMarketService } from "./modules/service/CoinMarketService";
import { WebService } from "./modules/service/WebService";
import { LedgerStorage } from "./modules/storage/LedgerStorage";
import {
    ConvertTypes,
    DisplayTxType,
    IBlock,
    IBlockEnrollment,
    IBlockEnrollmentElements,
    IBlockOverview,
    IBlockTransactionElements,
    IBlockTransactions,
    IBOAStats,
    IEmitBlock,
    IEmitTransaction,
    IMarketCap,
    IMarketChart,
    IPagination,
    IPendingTxs,
    IPreimage,
    ISPVStatus,
    ITransaction,
    ITransactionFee,
    ITxHistoryElement,
    ITxOverview,
    ITxStatus,
    IUnspentTxOutput,
    ValidatorData,
    IBOAHolder
} from "./Types";

import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import JSBI from "jsbi";
import bcrypt from 'bcrypt';
import { ObjectID } from "mongodb";
import { Socket } from "socket.io";
import sgMail from '@sendgrid/mail'
import { URL } from "url";
import events from "./modules/events/events";
import "./modules/events/handlers";
import User from './modules/models/userModel'
import Blacklist from './modules/models/blacklistModel'
import generateToken from './modules/common/generateToken'

class Stoa extends WebService {
    private _ledger_storage: LedgerStorage | null;

    /**
     * Network client to interact with Agora
     */
    private readonly agora: AgoraClient;
    /**
     * Stoa page size limit
     */
    private readonly limit_page_size: number = 100;

    /**
     * Instance of coin Market for stoa
     */
    public coinMarketService: CoinMarketService;

    /**
     * Chain of pending store operations
     *
     * To ensure swift response time to Agora when our handlers are called,
     * we start the storage asynchronously and respond immediately with HTTP/200.
     * This means that if we get called in a quick succession, we need to make sure
     * the data is processed serially. To do so, we chain `Promise`s in this member.
     */
    private pending: Promise<void>;

    /**
     * The maximum number of blocks that can be recovered at one time
     */
    private _max_count_on_recovery: number = 64;

    /**
     * The Database config
     */
    private databaseConfig: IDatabaseConfig;

    /**
     * The genesis timestamp
     */
    private readonly genesis_timestamp: number;

    /**
     * Constructor
     * @param databaseConfig Mysql database configuration
     * @param agora_endpoint The network endpoint to connect to Agora
     * @param port The network port of Stoa
     * @param address The network address of Stoa
     * @param genesis_timestamp The genesis timestamp
     */
    constructor(
        databaseConfig: IDatabaseConfig,
        agora_endpoint: URL,
        port: number | string,
        address: string,
        genesis_timestamp: number,
        coinMarketService: CoinMarketService
    ) {
        super(port, address);

        this.genesis_timestamp = genesis_timestamp;
        this._ledger_storage = null;
        this.databaseConfig = databaseConfig;
        this.coinMarketService = coinMarketService;
        // Instantiate a dummy promise for chaining
        this.pending = new Promise<void>(function (resolve, reject) {
            resolve();
        });
        // Do this last, as it is possible it will fail, and we only want failure
        // to happen after we checked that our own state is correct.
        this.agora = new AgoraClient(agora_endpoint);
    }

    /**
     * Creates a instance of LedgerStorage
     */
    public createStorage(): Promise<void> {
        return LedgerStorage.make(this.databaseConfig, this.genesis_timestamp).then((storage) => {
            this._ledger_storage = storage;
        });
    }

    /**
     * Returns the instance of LedgerStorage
     * This must be invoked after creating an instance of
     * `LedgerStorage` using `createStorage`.
     * @returns If `_ledger_storage` is not null, return `_ledger_storage`.
     * Otherwise, terminate the process.
     */
    public get ledger_storage(): LedgerStorage {
        if (this._ledger_storage !== null) return this._ledger_storage;
        else {
            logger.error("LedgerStorage is not ready yet.", {
                operation: Operation.start,
                height: "",
                success: false,
            });
            process.exit(1);
        }
    }

    /**
     * Setup and start the server
     */
    public async start(): Promise<void> {
        // Prepare middleware

        // parse application/x-www-form-urlencoded
        this.app.use(bodyParser.urlencoded({ extended: false, limit: "1mb" }));
        // parse application/json
        this.app.use(bodyParser.json({ limit: "1mb" }));
        this.app.use(cors(cors_options));

        // Prepare routes
        this.app.get("/block_height", this.getBlockHeight.bind(this));
        this.app.get("/block_height_at/:time", this.getBlockHeightAt.bind(this));
        this.app.get("/validators", this.getValidators.bind(this));
        this.app.get("/validator/:address", this.getValidator.bind(this));
        this.app.get("/transaction/pending/:hash", this.getTransactionPending.bind(this));
        this.app.get("/transaction/:hash", this.getTransaction.bind(this));
        this.app.get("/utxo/:address", this.getUTXO.bind(this));
        this.app.post("/utxos", this.getUTXOs.bind(this));
        this.app.get("/transaction/status/:hash", this.getTransactionStatus.bind(this));
        this.app.get("/transaction/fees/:tx_size", this.getTransactionFees.bind(this));
        this.app.get("/wallet/transactions/history/:address", this.getWalletTransactionsHistory.bind(this));
        this.app.get("/wallet/transaction/overview/:hash", this.getWalletTransactionOverview.bind(this));
        this.app.get("/wallet/transactions/pending/:address", this.getWalletTransactionsPending.bind(this));
        this.app.get("/wallet/blocks/header", this.getWalletBlocksHeader.bind(this));
        this.app.get("/latest-blocks", this.getLatestBlocks.bind(this));
        this.app.get("/latest-transactions", this.getLatestTransactions.bind(this));
        this.app.get("/block-summary", this.getBlockSummary.bind(this));
        this.app.get("/block-enrollments", this.getBlockEnrollments.bind(this));
        this.app.get("/block-transactions", this.getBlockTransactions.bind(this));
        this.app.get("/boa-stats", this.getBOAStats.bind(this));
        this.app.get("/spv/:hash", this.verifyPayment.bind(this));
        this.app.get("/coinmarketcap", this.getCoinMarketCap.bind(this));
        this.app.get("/coinmarketchart", this.getBoaPriceChart.bind(this));
        this.app.post("/block_externalized", this.postBlock.bind(this));
        this.app.post("/preimage_received", this.putPreImage.bind(this));
        this.app.post("/transaction_received", this.putTransaction.bind(this));
        this.app.get("/holders", this.getBoaHolders.bind(this));
        this.app.post("/register-user", this.registerUser.bind(this));
        this.app.post("/signin", this.signIn.bind(this));
        this.app.post("/addblacklist", this.addBlacklist.bind(this));
        this.app.get("/blacklist", this.allBlacklist.bind(this));
        this.app.post("/deleteblacklist", this.deleteBlacklist.bind(this));
        this.app.get("/operationlogs", this.getOperationLogs.bind(this));
        this.app.get("/operationlogs/search", this.searchOperationLogs.bind(this));
        this.app.get("/operationlogs/:id", this.getOperationLog.bind(this));
        this.app.get("/accesslogs", this.getAccessLogs.bind(this));
        this.app.get("/accesslogs/search", this.searchAccessLogs.bind(this));
        this.app.post("/recover", this.recover.bind(this));
        this.app.get("/reset/:token", this.reset.bind(this));
        this.app.post("/reset/:token", this.resetPassword.bind(this));

        let height: Height = new Height("0");
        await HeightManager.init(this);

        // Start the server once we can establish a connection to Agora
        return this.agora
            .getBlockHeight()
            .then(
                async (res) => {
                    height.value = JSBI.BigInt(res.value);
                    logger.info(`Connected to Agora, block height is ${res.toString()}`, {
                        operation: Operation.connection,
                        height: HeightManager.height.toString(),
                        success: true,
                    });
                    return super.start();
                },
                (err) => {
                    logger.error(`Error: Could not connect to Agora node: ${err.toString()}`, {
                        operation: Operation.connection,
                        height: HeightManager.height.toString(),
                        success: false,
                    });
                    process.exit(1);
                }
            )
            .then(() => {
                if (!(process.env.NODE_ENV === "test")) {
                    this.coinMarketService.start(this).catch((err) => {
                        logger.error(`Error: Could not connect to marketcap Client: ${err.toString()}`, {
                            operation: Operation.connection,
                            height: HeightManager.height.toString(),
                            success: false,
                        });
                    });
                    this.socket.io.on(events.client.connection, (socket: Socket) => {
                        this.eventDispatcher.dispatch(events.client.connection, socket);
                    });
                }
                return (this.pending = this.pending.then(() => {
                    return this.catchup(height);
                }));
            });
    }

    /**
     * GET /validators
     *
     * Called when a request is received through the `/validators` handler
     *
     * Returns a set of Validators based on the block height if there is a height.
     * If height was not provided the latest validator set is returned.
     */
    private getValidators(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        if (req.query.height !== undefined && !Utils.isPositiveInteger(req.query.height.toString())) {
            res.status(400).send(`Invalid value for parameter 'height': ${req.query.height.toString()}`);
            return;
        }

        let height = req.query.height !== undefined ? new Height(req.query.height.toString()) : null;

        if (height != null) logger.http(`GET /validators height=${height.toString()}`);
        else logger.http(`GET /validators`);

        this.ledger_storage
            .getValidatorsAPI(height, null)
            .then((rows: any[]) => {
                // Nothing found
                if (!rows.length) {
                    if (height !== null) res.status(400).send("No validator exists for block height.");
                    else res.status(503).send("Stoa is currently unavailable.");

                    return;
                }

                let out_put: Array<ValidatorData> = new Array<ValidatorData>();

                for (const row of rows) {
                    let preimage_hash: Buffer = row.preimage_hash;
                    let preimage_height: JSBI = JSBI.BigInt(row.preimage_height);
                    let target_height: Height = new Height(row.height);
                    let result_preimage_hash = new Hash(Buffer.alloc(Hash.Width));
                    let avail_height = JSBI.BigInt(row.avail_height);
                    let preimage_height_str: string;

                    // Hashing preImage
                    if (
                        JSBI.greaterThanOrEqual(target_height.value, avail_height) &&
                        JSBI.greaterThanOrEqual(
                            JSBI.add(avail_height, JSBI.BigInt(preimage_height)),
                            target_height.value
                        )
                    ) {
                        result_preimage_hash.fromBinary(preimage_hash, Endian.Little);
                        let count = JSBI.toNumber(
                            JSBI.subtract(JSBI.add(avail_height, JSBI.BigInt(preimage_height)), target_height.value)
                        );
                        for (let i = 0; i < count; i++) {
                            result_preimage_hash = hash(result_preimage_hash.data);
                            preimage_height = JSBI.subtract(preimage_height, JSBI.BigInt(1));
                        }
                        preimage_height_str = preimage_height.toString();
                    } else {
                        if (JSBI.equal(target_height.value, JSBI.BigInt(row.enrolled_at))) {
                            preimage_height_str = "0";
                            result_preimage_hash.fromBinary(row.commitment, Endian.Little);
                        } else {
                            preimage_height_str = "";
                            result_preimage_hash = new Hash(Buffer.alloc(Hash.Width));
                        }
                    }

                    let preimage: IPreimage = {
                        height: preimage_height_str,
                        hash: result_preimage_hash.toString(),
                    } as IPreimage;

                    let validator: ValidatorData = new ValidatorData(
                        row.address,
                        new Height(JSBI.BigInt(row.enrolled_at)),
                        new Hash(row.stake, Endian.Little).toString(),
                        preimage
                    );
                    out_put.push(validator);
                }
                res.status(200).send(JSON.stringify(out_put));
                let resTime: any = new Date().getTime() - time;
                logger.http(height ? `GET /validators/height=${height?.toString()}` : `/validators/height`, { endpoint: '/validators', RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });

            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /validator/:address
     *
     * Called when a request is received through the `/validators/:address` handler
     *
     * Returns a set of Validators based on the block height if there is a height.
     * If height was not provided the latest validator set is returned.
     * If an address was provided, return the validator data of the address if it exists.
     */
    private getValidator(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        if (req.query.height !== undefined && !Utils.isPositiveInteger(req.query.height.toString())) {
            res.status(400).send(`Invalid value for parameter 'height': ${req.query.height.toString()}`);
            return;
        }

        let height = req.query.height !== undefined ? new Height(req.query.height.toString()) : null;

        let address: string = String(req.params.address);

        if (height != null) logger.http(`GET /validator/${address} height=${height.toString()}`);
        else logger.http(`GET /validator/${address}}`);

        this.ledger_storage
            .getValidatorsAPI(height, address)
            .then((rows: any[]) => {
                // Nothing to show
                if (!rows.length) {
                    res.status(400).send(
                        `The validator data not found.` + `'address': (${address}), 'height': (${height?.toString()})`
                    );
                    return;
                }

                let out_put: Array<ValidatorData> = new Array<ValidatorData>();

                for (const row of rows) {
                    let preimage_hash: Buffer = row.preimage_hash;
                    let preimage_height: JSBI = JSBI.BigInt(row.preimage_height);
                    let target_height: Height = new Height(row.height);
                    let result_preimage_hash = new Hash(Buffer.alloc(Hash.Width));
                    let avail_height = JSBI.BigInt(row.avail_height);
                    let preimage_height_str: string;

                    // Hashing preImage
                    if (
                        JSBI.greaterThanOrEqual(target_height.value, avail_height) &&
                        JSBI.greaterThanOrEqual(
                            JSBI.add(avail_height, JSBI.BigInt(preimage_height)),
                            target_height.value
                        )
                    ) {
                        result_preimage_hash.fromBinary(preimage_hash, Endian.Little);
                        let count = JSBI.toNumber(
                            JSBI.subtract(JSBI.add(avail_height, JSBI.BigInt(preimage_height)), target_height.value)
                        );
                        for (let i = 0; i < count; i++) {
                            result_preimage_hash = hash(result_preimage_hash.data);
                            preimage_height = JSBI.subtract(preimage_height, JSBI.BigInt(1));
                        }
                        preimage_height_str = preimage_height.toString();
                    } else {
                        if (JSBI.equal(target_height.value, JSBI.BigInt(row.enrolled_at))) {
                            preimage_height_str = "0";
                            result_preimage_hash.fromBinary(row.commitment, Endian.Little);
                        } else {
                            preimage_height_str = "";
                            result_preimage_hash = new Hash(Buffer.alloc(Hash.Width));
                        }
                    }

                    let preimage: IPreimage = {
                        height: preimage_height_str,
                        hash: result_preimage_hash.toString(),
                    } as IPreimage;

                    let validator: ValidatorData = new ValidatorData(
                        row.address,
                        new Height(JSBI.BigInt(row.enrolled_at)),
                        new Hash(row.stake, Endian.Little).toString(),
                        preimage
                    );
                    out_put.push(validator);
                }
                res.status(200).send(JSON.stringify(out_put));
                let resTime: any = new Date().getTime() - time;
                logger.http(height ? `GET /validator/${address}/${height}` : `/validator`, { endpoint: `/validator`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/status/:hash
     *
     * Called when a request is received through the `/transaction/status/:hash` handler
     * The parameter `hash` is the hash of the transaction
     *
     * Returns a transaction status.
     */
    private getTransactionStatus(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let hash: string = String(req.params.hash);
        let tx_hash: Hash;
        try {
            tx_hash = new Hash(hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getTransactionStatus(tx_hash)
            .then((data: any) => {
                let status: ITxStatus = {
                    status: data.status,
                    tx_hash: new Hash(data.tx_hash, Endian.Little).toString(),
                };
                if (data.block !== undefined) {
                    status.block = {
                        height: data.block.height,
                        hash: new Hash(data.block.hash, Endian.Little).toString(),
                    };
                }
                res.status(200).send(JSON.stringify(status));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /transaction/status/${hash}`, { endpoint: `/transaction/status`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/fees/:tx_size
     *
     * Called when a request is received through the `/transaction/fees/:tx_size` handler
     *
     * Returns transaction fees by the transaction size.
     */
    private getTransactionFees(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let size: string = req.params.tx_size.toString();

        logger.http(`GET /transaction/fees/${size}}`);

        if (!Utils.isPositiveInteger(size)) {
            res.status(400).send(`Invalid value for parameter 'tx_size': ${size}`);
            return;
        }

        let tx_size = Number(size);
        this.ledger_storage
            .getFeeMeanDisparity()
            .then((value: number) => {
                let fees = FeeManager.getTxFee(tx_size, value);
                let data: ITransactionFee = {
                    tx_size: tx_size,
                    high: fees[0].toString(),
                    medium: fees[1].toString(),
                    low: fees[2].toString(),
                };
                res.status(200).send(JSON.stringify(data));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /transaction/fees/${size}`, { endpoint: `/transaction/fees`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/pending/:hash
     *
     * Called when a request is received through the `/transaction/pending/:hash` handler
     *
     * Returns a pending transaction by the transaction hash.
     */
    private getTransactionPending(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let hash: string = String(req.params.hash);
        let tx_hash: Hash;
        try {
            tx_hash = new Hash(hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getTransactionPending(tx_hash)
            .then((tx) => {
                if (tx === null) {
                    res.status(204).send(`No pending transactions. hash': (${hash})`);
                    return;
                }

                res.status(200).send(JSON.stringify(tx));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /transaction/pending/${hash}`, { endpoint: `/transaction/pending`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /transaction/:hash
     *
     * Called when a request is received through the `/transaction/:hash` handler
     *
     * Returns a transaction by the transaction hash.
     */
    private getTransaction(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let hash: string = String(req.params.hash);
        let tx_hash: Hash;
        try {
            tx_hash = new Hash(hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getTransaction(tx_hash)
            .then((tx) => {
                if (tx === null) {
                    res.status(204).send(`No transactions. hash': (${hash})`);
                    return;
                }

                res.status(200).send(JSON.stringify(tx));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /transaction/${hash}`, { endpoint: `/transaction`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /utxo/:address
     *
     * Called when a request is received through the `/utxo/:address` handler
     *
     * Returns a set of UTXOs of the address.
     */
    private getUTXO(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let address: string = String(req.params.address);
        this.ledger_storage
            .getUTXO(address)
            .then((rows: any[]) => {
                let utxo_array: Array<IUnspentTxOutput> = [];
                for (const row of rows) {
                    let utxo = {
                        utxo: new Hash(row.utxo, Endian.Little).toString(),
                        type: row.type,
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        amount: JSBI.BigInt(row.amount).toString(),
                        height: JSBI.BigInt(row.block_height).toString(),
                        time: row.block_time,
                        lock_type: row.lock_type,
                        lock_bytes: row.lock_bytes.toString("base64"),
                    };
                    utxo_array.push(utxo);
                }
                res.status(200).send(JSON.stringify(utxo_array));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /utxo/${address}`, { endpoint: `/utxo`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * POST /utxos
     *
     * Called when a request is received through the `/utxos/` handler
     *
     * Returns UTXO's information about the UTXO hash array.
     */
    private getUTXOs(req: express.Request, res: express.Response) {
        if (req.body.utxos === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'utxos' object in body",
            });
            return;
        }

        logger.http(`POST /utxos utxos=${req.body.utxos.toString()}`);

        let utxos_hash: Array<Hash>;
        try {
            utxos_hash = req.body.utxos.map((m: string) => new Hash(m));
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'utxos': ${req.body.utxos.toString()}`);
            return;
        }

        this.ledger_storage
            .getUTXOs(utxos_hash)
            .then((rows: any[]) => {
                let utxo_array: Array<IUnspentTxOutput> = [];
                for (const row of rows) {
                    let utxo = {
                        utxo: new Hash(row.utxo, Endian.Little).toString(),
                        type: row.type,
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        amount: JSBI.BigInt(row.amount).toString(),
                        height: JSBI.BigInt(row.block_height).toString(),
                        time: row.block_time,
                        lock_type: row.lock_type,
                        lock_bytes: row.lock_bytes.toString("base64"),
                    };
                    utxo_array.push(utxo);
                }
                res.status(200).send(JSON.stringify(utxo_array));
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/transactions/history/:address
     *
     * Called when a request is received through the `/wallet/transactions/history/:address` handler
     * ```
     * The parameter `address` are the address to query.
     * The parameter `pageSize` is the maximum size that can be obtained
     *      from one query, default is 10
     * The parameter `page` is the number on the page, this value begins with 1,
     *      default is 1
     * The parameter `type` is the type of transaction to query.
     *      This can include multiple types.
     *      Transaction types include "inbound", "outbound", "freeze", "payload".
     *      The "inbound" is an increased transaction of funds at the address.
     *      The "outbound" is a transaction with reduced funds at the address.
     *      Users can select only "inbound", "outbound".
     *      The "freeze", "payload" are always included.
     *      default is "inbound,outbound,freeze,payload"
     * The parameter `beginDate` is the start date of the range of dates to look up.
     * The parameter `endDate` is the end date of the range of dates to look up.
     * The parameter `peer` is used when users want to look up only specific
     *      address of their counterparts.
     *      Peer is the withdrawal address in the inbound transaction and
     *      a deposit address in the outbound transaction
     * Returns a set of transactions history of the addresses.
     * ```
     */
    private async getWalletTransactionsHistory(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let address: string = String(req.params.address);
        let filter_begin: number | undefined;
        let filter_end: number | undefined;
        let page_size: number;
        let page: number;
        let filter_type: Array<DisplayTxType>;

        // Validating Parameter - beginDate, endDate
        if (req.query.beginDate !== undefined && req.query.endDate !== undefined) {
            if (!Utils.isPositiveInteger(req.query.beginDate.toString())) {
                res.status(400).send(`Invalid value for parameter 'beginDate': ${req.query.beginDate.toString()}`);
                return;
            }

            if (!Utils.isPositiveInteger(req.query.endDate.toString())) {
                res.status(400).send(`Invalid value for parameter 'endDate': ${req.query.endDate.toString()}`);
                return;
            }

            filter_begin = Number(req.query.beginDate.toString());
            filter_end = Number(req.query.endDate.toString());

            if (filter_begin > filter_end) {
                res.status(400).send(
                    `Parameter beginDate must be less than a parameter endDate. 'beginDate': (${filter_begin}), 'endDate': (${filter_end})`
                );
                return;
            }
        } else if (req.query.beginDate !== undefined && req.query.endDate === undefined) {
            res.status(400).send(`Parameter endDate must also be set.`);
            return;
        } else if (req.query.beginDate === undefined && req.query.endDate !== undefined) {
            res.status(400).send(`Parameter beginDate must also be set.`);
            return;
        } else {
            filter_begin = undefined;
            filter_end = undefined;
        }
        filter_type =
            req.query.type !== undefined
                ? req.query.type
                    .toString()
                    .split(",")
                    .map((m) => ConvertTypes.toDisplayTxType(m))
                : [0, 1, 2, 3];

        if (filter_type.find((m) => m < 0) !== undefined) {
            res.status(400).send(`Invalid transaction type: ${req.query.type}`);
            return;
        }

        let filter_peer = req.query.peer !== undefined ? req.query.peer.toString() : undefined;
        let pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getWalletTransactionsHistory(
                address,
                pagination.pageSize,
                pagination.page,
                filter_type,
                filter_begin,
                filter_end,
                filter_peer
            )
            .then((rows: any[]) => {
                let out_put: Array<ITxHistoryElement> = [];
                for (const row of rows) {
                    out_put.push({
                        display_tx_type: ConvertTypes.DisplayTxTypeToString(row.display_tx_type),
                        address: row.address,
                        peer: row.peer,
                        peer_count: row.peer_count,
                        height: JSBI.BigInt(row.height).toString(),
                        time: row.block_time,
                        tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                        tx_type: ConvertTypes.TxTypeToString(row.type),
                        amount: JSBI.BigInt(row.amount).toString(),
                        unlock_height: JSBI.BigInt(row.unlock_height).toString(),
                        unlock_time: row.unlock_time,
                    });
                }
                res.status(200).send(JSON.stringify(out_put));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /wallet/transactions/history/${address}`, { endpoint: `/wallet/transactions/history`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/transaction/overview/:hash
     *
     * Called when a request is received through the `/transaction_overview/:addresses` handler
     * The parameter `hash` is the hash of the transaction
     *
     * Returns a transaction overview.
     */
    private getWalletTransactionOverview(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let txHash: string = String(req.params.hash);
        let tx_hash: Hash;
        try {
            tx_hash = new Hash(txHash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${txHash}`);
            return;
        }

        this.ledger_storage
            .getWalletTransactionOverview(tx_hash)
            .then((data: any) => {
                if (
                    data === undefined ||
                    data.tx === undefined ||
                    data.senders === undefined ||
                    data.receivers === undefined
                ) {
                    res.status(500).send("Failed to data lookup");
                    return;
                }

                if (data.tx.length == 0) {
                    res.status(204).send(`The data does not exist. 'hash': (${tx_hash})`);
                    return;
                }

                let overview: ITxOverview = {
                    status: "Confirmed",
                    height: JSBI.BigInt(data.tx[0].height).toString(),
                    time: data.tx[0].block_time,
                    tx_hash: new Hash(data.tx[0].tx_hash, Endian.Little).toString(),
                    tx_type: ConvertTypes.TxTypeToString(data.tx[0].type),
                    tx_size: data.tx[0].tx_size,
                    unlock_height: JSBI.BigInt(data.tx[0].unlock_height).toString(),
                    lock_height: JSBI.BigInt(data.tx[0].lock_height).toString(),
                    unlock_time: data.tx[0].unlock_time,
                    payload: data.tx[0].payload !== null ? data.tx[0].payload.toString("base64") : "",
                    senders: [],
                    receivers: [],
                    fee: JSBI.add(JSBI.BigInt(data.tx[0].tx_fee), JSBI.BigInt(data.tx[0].payload_fee)).toString(),
                };

                for (let elem of data.senders)
                    overview.senders.push({
                        address: elem.address,
                        amount: elem.amount,
                        utxo: new Hash(elem.utxo, Endian.Little).toString(),
                        signature: new Hash(elem.signature, Endian.Little).toString(),
                        index: elem.in_index,
                        unlock_age: elem.unlock_age,
                        bytes: new Hash(elem.bytes, Endian.Little).toString(),
                    });

                for (let elem of data.receivers)
                    overview.receivers.push({
                        type: elem.type,
                        address: elem.address,
                        lock_type: elem.lock_type,
                        amount: elem.amount,
                        utxo: new Hash(elem.utxo, Endian.Little).toString(),
                        index: elem.output_index,
                        bytes: hash(elem.bytes).toString(),
                    });

                res.status(200).send(JSON.stringify(overview));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /wallet/transaction/overview/${txHash}`, { endpoint: `/wallet/transaction/overview`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block-summary
     *
     * Called when a request is received through the `/block-summary` handler
     * The parameter `height` is the height and `hash` is the hash of block
     *
     * Returns a block overview.
     */
    private getBlockSummary(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let field: string;
        let value: string | Buffer;

        // Validating Parameter - height
        if (req.query.height !== undefined && Utils.isPositiveInteger(req.query.height.toString())) {
            field = "height";
            value = String(req.query.height);
        }
        // Validating Parameter - hash
        else if (req.query.hash !== undefined) {
            field = "hash";
            try {
                const hash: string = String(req.query.hash);
                value = new Hash(hash).toBinary(Endian.Little);
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'hash': ${req.query.hash}`);
                return;
            }
        } else {
            res.status(400).send(
                `Invalid value for parameter 'height': ${req.query.height} and 'hash': ${req.query.hash}`
            );
            return;
        }

        this.ledger_storage
            .getBlockSummary(field, value)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.length === 0) {
                    res.status(204).send(`The data does not exist. 'height': (${value})`);
                    return;
                } else {
                    let overview: IBlockOverview = {
                        height: JSBI.BigInt(data[0].height).toString(),
                        total_transactions: data[0].tx_count,
                        hash: new Hash(data[0].hash, Endian.Little).toString(),
                        prev_hash: new Hash(data[0].prev_block, Endian.Little).toString(),
                        merkle_root: new Hash(data[0].merkle_root, Endian.Little).toString(),
                        signature: new Hash(data[0].signature, Endian.Little).toString(),
                        random_seed: new Hash(data[0].random_seed, Endian.Little).toString(),
                        time: data[0].time_stamp,
                        version: "v0.x.x",
                        total_sent: data[0].total_sent,
                        total_received: data[0].total_received,
                        total_reward: data[0].total_reward,
                        total_fee: data[0].total_fee,
                        total_size: data[0].total_size,
                    };
                    res.status(200).send(JSON.stringify(overview));
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /block-summary/`, { endpoint: `/block-summary/`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                }
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block-enrollments
     *
     * Called when a request is received through the `/block-enrollments` handler
     * The parameter `height` is the height and `hash` is the hash of block
     *
     *@returns Returns enrolled validators of block.
     */
    private async getBlockEnrollments(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let field: string;
        let value: string | Buffer;

        // Validating Parameter - height
        if (req.query.height !== undefined && Utils.isPositiveInteger(req.query.height.toString())) {
            field = "height";
            value = String(req.query.height);
        }
        // Validating Parameter - hash
        else if (req.query.hash !== undefined) {
            field = "hash";
            try {
                const hash: string = String(req.query.hash);
                value = new Hash(hash).toBinary(Endian.Little);
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'hash': ${req.query.hash}`);
                return;
            }
        } else {
            res.status(400).send(
                `Invalid value for parameter 'height': ${req.query.height} and 'hash': ${req.query.hash}`
            );
            return;
        }

        let pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getBlockEnrollments(field, value, pagination.pageSize, pagination.page)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.total_records === 0) {
                    return res.status(204).send(`The data does not exist. 'height': (${value})`);
                } else {
                    let enrollmentElementList: Array<IBlockEnrollmentElements> = [];
                    for (const row of data.enrollments) {
                        enrollmentElementList.push({
                            height: JSBI.BigInt(row.block_height).toString(),
                            utxo: new Hash(row.utxo_key, Endian.Little).toString(),
                            enroll_sig: new Hash(row.enroll_sig, Endian.Little).toString(),
                            commitment: new Hash(row.commitment, Endian.Little).toString(),
                            cycle_length: row.cycle_length,
                        });
                    }
                    let enrollmentList: IBlockEnrollment = {
                        enrollmentElementList,
                        total_data: data.total_records,
                    };
                    res.status(200).send(JSON.stringify(enrollmentList));
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /block-enrollments/`, { endpoint: `/block-enrollments/`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return
                }
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block-transactions
     *
     * Called when a request is received through the `/block-transactions` handler
     * The parameter `height` is the height and `hash` is the hash of block
     *
     * @returns Returns transactions of block.
     */
    private async getBlockTransactions(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let field: string;
        let value: string | Buffer;
        let limit: number;
        let page: number;

        // Validating Parameter - height
        if (req.query.height !== undefined && Utils.isPositiveInteger(req.query.height.toString())) {
            field = "height";
            value = String(req.query.height);
        }
        // Validating Parameter - hash
        else if (req.query.hash !== undefined) {
            field = "hash";
            try {
                const hash: string = String(req.query.hash);
                value = new Hash(hash).toBinary(Endian.Little);
            } catch (error) {
                res.status(400).send(`Invalid value for parameter 'hash': ${req.query.hash}`);
                return;
            }
        } else {
            res.status(400).send(
                `Invalid value for parameter 'height': ${req.query.height} and 'hash': ${req.query.hash}`
            );
            return;
        }

        let pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage
            .getBlockTransactions(field, value, pagination.pageSize, pagination.page)
            .then((data: any) => {
                if (data === undefined) {
                    res.status(500).send("Failed to data lookup");
                    return;
                } else if (data.tx.length === 0) {
                    return res.status(204).send(`The data does not exist. 'height': (${value})`);
                } else {
                    let tx: Array<IBlockTransactionElements> = [];
                    for (const row of data.tx) {
                        tx.push({
                            height: JSBI.BigInt(row.block_height).toString(),
                            tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                            amount: row.amount,
                            type: row.type,
                            fee: row.tx_fee,
                            size: row.tx_size,
                            time: row.time_stamp,
                            sender_address: row.sender_address,
                            receiver: row.receiver,
                        });
                    }

                    let transactionList: IBlockTransactions = {
                        tx,
                        total_data: data.total_data,
                    };
                    res.status(200).send(JSON.stringify(transactionList));
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /block-transactions/`, { endpoint: `/block-transactions/`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return
                }
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /boa-stats
     *
     * Called when a request is received through the `/boa-stats` handler
     *
     * @returns Returns statistics of BOA coin.
     */
    private getBOAStats(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        logger.http(`GET /boa-stats/`);

        this.ledger_storage
            .getBOAStats()
            .then((data: any[]) => {
                if (!data[0]) {
                    return res.status(500).send("Failed to data lookup");
                } else {
                    let boaStats: IBOAStats = {
                        height: data[0].height,
                        transactions: data[0].transactions,
                        validators: data[0].validators,
                        frozen_coin: 5283595, //FIX ME static data because of unavailability of real data
                        circulating_supply: 5283535,
                        active_validators: 155055,
                    };
                    res.status(200).send(JSON.stringify(boaStats));
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`/boa-stats/`, { endpoint: `/boa-stats/`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return
                }
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                return res.status(500).send("Failed to data lookup");
            });
    }

    private verifyPayment(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let hash: string = String(req.params.hash);

        let tx_hash: Hash;

        try {
            tx_hash = new Hash(hash);
        } catch (error) {
            res.status(400).send(`Invalid value for parameter 'hash': ${hash}`);
            return;
        }

        this.ledger_storage
            .getBlockHeaderByTxHash(tx_hash)
            .then((rows: any) => {
                if (rows.length == 0) {
                    let status: ISPVStatus = {
                        result: false,
                        message: "Transaction does not exist in block",
                    };
                    res.status(200).send(JSON.stringify(status));
                    return;
                }
                this.agora
                    .getMerklePath(rows[0].height, tx_hash)
                    .then((path: Array<Hash>) => {
                        let root = new Hash(rows[0].merkle_root, Endian.Little);

                        if (
                            Buffer.compare(
                                AgoraClient.checkMerklePath(path, tx_hash, rows[0].tx_index).data,
                                root.data
                            ) === 0
                        ) {
                            let status: ISPVStatus = {
                                result: true,
                                message: "Success",
                            };
                            res.status(200).send(JSON.stringify(status));
                        } else {
                            let status: ISPVStatus = {
                                result: false,
                                message: "Verification failed",
                            };
                            res.status(200).send(JSON.stringify(status));
                            let resTime: any = new Date().getTime() - time;
                            logger.http(`GET /spv/${hash}`, { endpoint: `/spv`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                        }
                    })
                    .catch((error) => {
                        let status: ISPVStatus = {
                            result: false,
                            message: error.message,
                        };
                        res.status(200).send(JSON.stringify(status));
                    });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * POST /block_externalized
     *
     * When a request is received through the `/push` handler
     * we we call the storage handler asynchronously and  immediately
     * respond to Agora.
     */
    private postBlock(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        if (req.body.block === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'block' object in body",
            });
            return;
        }

        logger.http(`POST /block_externalized block=${req.body.block.toString()}`, {
            operation: Operation.db,
            height: "",
            success: true,
        });

        // To do
        // For a more stable operating environment,
        // it would be necessary to consider organizing the pool
        // using the database instead of the array.
        this.pending = this.pending.then(() => {
            return this.task({ type: "block", data: req.body.block });
        });

        res.status(200).send();
        let resTime: any = new Date().getTime() - time;
        logger.http(`POST /block_externalized=${req.body.block.toString()}`, { endpoint: `/block_externalized`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
    }

    /**
     * POST /preimage_received
     *
     * When a request is received through the `/preimage_received` handler
     * JSON preImage data is parsed and stored on each storage.
     */
    private putPreImage(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        if (req.body.preimage === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'preimage' object in body",
            });
            return;
        }

        // To do
        // For a more stable operating environment,
        // it would be necessary to consider organizing the pool
        // using the database instead of the array.
        this.pending = this.pending.then(() => {
            return this.task({ type: "pre_image", data: req.body.preimage });
        });

        res.status(200).send();
        let resTime: any = new Date().getTime() - time;
        logger.http(`POST /preimage_received preimage=${req.body.preimage.toString()}`, { endpoint: `/preimage_received preimage`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
    }

    /**
     * Put Coin market data to database
     *
     * This method Store the Coin market data to database.
     */
    public putCoinMarketStats(data: IMarketCap): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.ledger_storage
                .storeCoinMarket(data)
                .then((result: any) => {
                    if (result.affectedRows) {
                        logger.info(`CoinMarket: Data Update Completed`, {
                            operation: Operation.db,
                            height: HeightManager.height.toString(),
                            success: true,
                        });
                        resolve(result);
                    }
                })
                .catch((err) => {
                    logger.error("Failed to Store coin market cap data." + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        success: false,
                    });
                    reject(err);
                });
        });
    }

    /**
     * POST /transaction_received
     *
     * When a request is received through the `/transaction_received` handler
     * JSON transaction data is parsed and stored on each storage.
     */
    private putTransaction(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        if (req.body.tx === undefined) {
            res.status(400).send({
                statusMessage: "Missing 'tx' object in body",
            });
            return;
        }

        logger.http(`POST /transaction_received tx=${req.body.tx.toString()}`);

        this.pending = this.pending.then(() => {
            return this.task({ type: "transaction", data: req.body.tx });
        });

        res.status(200).send();
        let resTime: any = new Date().getTime() - time;
        logger.http(`POST /transaction_received tx=${req.body.tx.toString()}`, { endpoint: `/transaction_received`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
    }

    /**
     * GET /wallet/transactions/pending/:address
     *
     * Called when a request is received through the `/transactions/pending/:address` handler
     *
     * Returns List the total by output address of the pending transaction.
     */
    private getWalletTransactionsPending(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let address: string = String(req.params.address);

        logger.http(`GET /wallet/transactions/pending/${address}}`);

        this.ledger_storage
            .getWalletTransactionsPending(address)
            .then((rows: any[]) => {
                if (!rows.length) {
                    res.status(204).send(`No pending transactions. address': (${address})`);
                    return;
                }

                let pending_array: Array<IPendingTxs> = [];
                for (const row of rows) {
                    let tx = {
                        tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                        submission_time: row.time,
                        address: row.address,
                        amount: JSBI.BigInt(row.amount).toString(),
                        fee: JSBI.add(JSBI.BigInt(row.tx_fee), JSBI.BigInt(row.payload_fee)).toString(),
                        block_delay: row.current_height - row.received_height,
                    };
                    pending_array.push(tx);
                }
                res.status(200).send(JSON.stringify(pending_array));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /wallet/transactions/pending/${address}`, { endpoint: `/wallet/transactions/pending`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /wallet/blocks/header
     *
     * Called when a request is received through the `/wallet/blocks/header`
     *
     * Returns information about the header of the block according to the height of the block.
     * If height was not provided the information of the last block header is returned.
     */
    private getWalletBlocksHeader(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        if (req.query.height !== undefined && !Utils.isPositiveInteger(req.query.height.toString())) {
            res.status(400).send(`Invalid value for parameter 'height': ${req.query.height.toString()}`);
            return;
        }

        let height = req.query.height !== undefined ? new Height(req.query.height.toString()) : null;

        if (height != null) logger.http(`GET /wallet/blocks/header height=${height.toString()}`);
        else logger.http(`GET /wallet/blocks/header`);

        this.ledger_storage
            .getWalletBlocksHeaderInfo(height)
            .then((rows: any[]) => {
                if (!rows.length) {
                    res.status(204).send(`No blocks`);
                    return;
                }

                let info = {
                    height: rows[0].height.toString(),
                    hash: new Hash(rows[0].hash, Endian.Little).toString(),
                    merkle_root: new Hash(rows[0].merkle_root, Endian.Little).toString(),
                    time_stamp: rows[0].time_stamp,
                };
                res.status(200).send(JSON.stringify(info));
                let resTime: any = new Date().getTime() - time;
                logger.http(height ? `GET /wallet/blocks/header/height=${height?.toString()}` : `/wallet/blocks/header`, { endpoint: `/wallet/blocks/header`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block_height
     *
     * Return the highest block height stored in Stoa
     */
    private getBlockHeight(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        this.ledger_storage
            .getBlockHeight()
            .then((row: Height | null) => {
                if (row == null) {
                    res.status(400).send(`The block height not found.`);
                }
                else {
                    res.status(200).send(JSON.stringify(row));
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /block_height`, { endpoint: '/block_height', RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                }

            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * GET /block_height_at/:time
     *
     * Return the block height corresponding to to the block creation time
     */
    private getBlockHeightAt(req: express.Request, res: express.Response) {
        if (req.params.time === undefined) {
            res.status(400).send(`Invalid value for parameter 'time'`);
            return;
        }

        if (!Utils.isPositiveInteger(req.params.time.toString())) {
            res.status(400).send(`Invalid value for parameter 'time': ${req.params.time.toString()}`);
            return;
        }

        const time_stamp = Number(req.params.time.toString());
        logger.http(`GET /block_height_at time=${time_stamp.toString()}`);

        this.ledger_storage
            .getEstimatedBlockHeight(time_stamp)
            .then((height: Height | null) => {
                if (height === null) res.status(204).send("No Content");
                else res.status(200).send(JSON.stringify(height));
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.status(500).send("Failed to data lookup");
            });
    }

    /**
     * Extract the block height from JSON.
     * @param block
     */
    private static getJsonBlockHeight(block: any): Height {
        if (block.header === undefined || block.header.height === undefined) {
            throw Error("Not found block height in JSON Block");
        }

        return new Height(block.header.height);
    }

    /**
     * Get latest blocks
     * @param req
     * @param res
     * @returns Return Latest blocks of the ledger
     */
    private async getLatestBlocks(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage.getLatestBlocks(pagination.pageSize, pagination.page).then((data: any) => {
            if (data === undefined) {
                res.status(500).send("Failed to data lookup");
                return;
            } else if (data.length === 0) {
                return res.status(204).send(`The data does not exist.`);
            } else {
                let block_list: Array<IBlock> = [];
                for (const row of data) {
                    block_list.push({
                        height: JSBI.BigInt(row.height).toString(),
                        hash: new Hash(row.hash, Endian.Little).toString(),
                        merkle_root: new Hash(row.merkle_root, Endian.Little).toString(),
                        signature: new Hash(row.signature, Endian.Little).toString(),
                        validators: row.validators.toString(),
                        tx_count: row.tx_count.toString(),
                        enrollment_count: row.enrollment_count.toString(),
                        time_stamp: row.time_stamp,
                    });
                }
                res.status(200).send(JSON.stringify(block_list));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /latest-blocks`, { endpoint: `/latest-blocks`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                return
            }
        });
    }

    /**
     * Get Latest transactions
     * @param req
     * @param res
     * @returns Returns Latest transactions of the ledger.
     */
    private async getLatestTransactions(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage.getLatestTransactions(pagination.pageSize, pagination.page).then((data: any) => {
            if (data === undefined) {
                res.status(500).send("Failed to data lookup");
                return;
            } else if (data.length === 0) {
                return res.status(204).send(`The data does not exist.`);
            } else {
                let transactionList: Array<ITransaction> = [];
                for (const row of data) {
                    transactionList.push(
                        {
                            height: JSBI.BigInt(row.block_height).toString(),
                            tx_hash: new Hash(row.tx_hash, Endian.Little).toString(),
                            type: row.type,
                            amount: JSBI.BigInt(row.amount).toString(),
                            tx_fee: JSBI.BigInt(row.tx_fee).toString(),
                            tx_size: JSBI.BigInt(row.tx_size).toString(),
                            time_stamp: row.time_stamp,
                        }
                    )
                }
                res.status(200).send(JSON.stringify(transactionList));
                let resTime: any = new Date().getTime() - time;
                logger.http(`GET /latest-transactions`, { endpoint: `/latest-transactions`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                return
            }
        })
    }
    /**
     * Register new admin user
    */
    public async registerUser(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        try {
            const { name, email, password } = req.body;
            this.ledger_storage.registerUser(name, email, password).then((data: any) => {
                if (data === undefined) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /register-user`,
                        { endpoint: `/register-user`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(500).json('Internal server error');
                } else if (data === true) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /register-user`,
                        { endpoint: `/register-user`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(409).json('User already exist');
                } else {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /register-user`,
                        { endpoint: `/register-user`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(200).json(data);
                }
            })
            // const exisitngUser = await User.findOne({ email: email });
            // if (exisitngUser) {
            //     res.status(409).send('User already registered');
            //     let resTime: any = new Date().getTime() - time;
            //     logger.http(`POST /register-user`, { endpoint: `/register-user`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            //     return;

            // }
            // const hashedPassword = bcrypt.hashSync(password, 10);
            // const userRecord = await User.create({
            //     name: name,
            //     email: email,
            //     password: hashedPassword
            // });
            // res.status(200).json({ message: 'User created successfully', email });
            // let resTime: any = new Date().getTime() - time;
            // logger.http(`POST /register-user`, { endpoint: `/register-user`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            // if (!userRecord) {
            //     res.status(500).send("Interal server error");
            // }
            // return { userRecord }
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
     * Sign in to the admin panel
    */
    public async signIn(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        try {
            const { email, password } = req.body;
            this.ledger_storage.signInUser(email, password).then((data) => {
                if (data === undefined) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /signin`,
                        { endpoint: `/signin`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(400).json('Email or password is incorrect');
                } else {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /signin`,
                        { endpoint: `/signin`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(200).json(data);
                }
            })
            // const user = await User.findOne({ email: email });
            // if (!user) {
            //     res.status(400).send('The email address ' + email + ' is not associated with any account. Double-check your email address and try again.');
            //     let resTime: any = new Date().getTime() - time;
            //     logger.http(`POST /signin`, { endpoint: `/signin`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            //     return;
            // }
            // user.comparePassword(password, (err: any, isMatch: any) => {
            //     if (err) {
            //         res.status(400).send("Invalid password");
            //         let resTime: any = new Date().getTime() - time;
            //         logger.http(`POST /signin`, { endpoint: `/signin`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            //         return;
            //     }
            //     else {
            //         const token: string = generateToken(email);
            //         res.status(200).json({ message: 'Login successfully', token })
            //         let resTime: any = new Date().getTime() - time;
            //         logger.http(`POST /signin`, { endpoint: `/signin`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            //         return { token };
            //     }
            // })
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    * get all operation logs
    */
    public async getOperationLogs(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        let pagination: IPagination = await this.paginate(req, res);
        try {
            this.ledger_storage.operationLogs(pagination.pageSize, pagination.page).then((data: any) => {

                if (data === undefined) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /operationlogs`,
                        { endpoint: `/operationlogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(500).json('Failed to data lookup');
                } else if (data.length === 0) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /operationlogs`,
                        { endpoint: `/operationlogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(200).json('No log found');
                } else {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /operationlogs`,
                        { endpoint: `/operationlogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(200).json(data);
                }
            })
            // let db = Logger.dbInstance.connection.db
            // db.collection('operation_logs').find().skip((pagination.page - 1) * pagination.page).limit(pagination.pageSize).toArray((er: any, result: any) => {
            //     res.status(200).json(result);
            //     let resTime: any = new Date().getTime() - time;
            //     logger.http(`GET /operationlogs`, { endpoint: `/operationlogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            // });
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    * get all access logs
    */
    public async getAccessLogs(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        let pagination: IPagination = await this.paginate(req, res);
        try {
            this.ledger_storage.accsessLogs(pagination.pageSize, pagination.page).then((data: any) => {

                if (data === undefined) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /accesslogs`,
                        { endpoint: `/accesslogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(500).json('Failed to data lookup');
                } else if (data.length === 0) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /accesslogs`,
                        { endpoint: `/accesslogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(200).json('No log found');
                } else {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /accesslogs`,
                        { endpoint: `/accesslogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(200).json(data);
                }
            })
            // let db = Logger.dbInstance
            // db = db.connection.db
            // db.collection('access_logs').find().skip((pagination.page - 1) * pagination.page).limit(pagination.pageSize).toArray((er: any, result: any) => {
            //     res.status(200).json(result);
            //     let resTime: any = new Date().getTime() - time;
            //     logger.http(`GET /accesslogs`, { endpoint: `/accesslogs`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            // });
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    * get detailed opreation log
    */
    public async getOperationLog(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        let id = new ObjectID(req.params.id);
        try {
            this.ledger_storage.operationLog(id).then((data: any) => {

                if (data === undefined) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /operationlogs/:id`,
                        { endpoint: `/operationlogs/:id`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(500).json('Failed to data lookup');
                } else {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /operationlogs/:id`,
                        { endpoint: `/operationlogs/:id`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    res.status(200).json(data);
                }
            })
            // let db = Logger.dbInstance;
            // db = db.connection.db;
            // let data = await db.collection('operation_logs').findOne({ _id: id })
            // res.status(200).send(JSON.stringify(data))
            // let resTime: any = new Date().getTime() - time;
            // logger.http(`GET /operationlogs/:id`, { endpoint: `/operationlogs/:id`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
        }
        catch (error) {
            logger.error('Error', error);

        }
    };
    /**
    * get passwordToken and verify the token
    */
    public async reset(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        try {
            const { token } = req.params;

            const user = await User.findOne({ resetPasswordToken: token, resetPasswordExpires: { $gt: Date.now() } });

            if (!user) {
                let resTime: any = new Date().getTime() - time;
                res.status(401).json({ message: 'Password reset token is invalid or has expired.' });
                logger.http(`GET /reset/:token`, { endpoint: `/reset/:token`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                return;
            }

            //Redirect user to form with the email address
            let resTime: any = new Date().getTime() - time;
            logger.http(`GET /reset/:token`, { endpoint: `/reset/:token`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            res.status(200).send({ message: 'Token verified' })
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    * reset user password
    */
    public async resetPassword(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        try {
            const { token } = req.params;
            const { password } = req.body;

            const user = await User.findOne({ resetPasswordToken: token, resetPasswordExpires: { $gt: Date.now() } });
            if (!user) {
                let resTime: any = new Date().getTime() - time;
                res.status(401).json({ message: 'Password reset token is invalid or has expired.' });
                logger.http(`POST /reset/:token`, { endpoint: `/reset/:token`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                return;
            }
            //Set the new password
            user.password = password;
            user.resetPasswordToken = undefined;
            user.resetPasswordExpires = undefined;
            user.isVerified = true;

            // Save the updated user object
            await user.save();
            let resTime: any = new Date().getTime() - time;
            logger.http(`POST /reset/:token`, { endpoint: `/reset/:token`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            res.status(200).json({ message: 'Your password has been updated.' })
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    * Forget password, send mail through sendgrid
    */
    public async recover(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        const { email } = req.body;
        let host = req.headers.host;
        try {
            const user = await User.findOne({ email: email });
            if (!user) {
                res.status(400).send('The email address ' + email + ' is not associated with any account. Double-check your email address and try again.');
                let resTime: any = new Date().getTime() - time;
                logger.http(`POST /recover`, { endpoint: `/recover`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                return;
            }

            //Generate and set password reset token
            user.generatePasswordReset();
            // Save the updated user object
            await user.save()
                .then(user => {
                    let link = "http://" + host + "/reset/" + user.resetPasswordToken;
                    // send email
                    const mailOptions = {
                        to: user.email,
                        from: 'ahmed@rnssol.com',//email of the sender
                        subject: "Password change request",
                        html: `Hi \n 
                Please click on the following link ${link} to reset your password. \n\n 
                If you did not request this, please ignore this email and your password will remain unchanged.\n`,
                    };

                    sgMail
                        .send(mailOptions).then(() => {
                            res.status(200).json({ message: 'Email sent successfully' })
                            let resTime: any = new Date().getTime() - time;
                            logger.http(`POST /recover`, { endpoint: `/recover`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                        })
                        .catch((error) => {
                            res.status(500).json({ message: error.message });
                            logger.error('Something went wrong, unable to send mail. Error :', error)
                            return;
                        })

                }).catch(err => logger.error('User db error', err));
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    *   Add blacklist ip address to database
    */
    public async addBlacklist(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        try {
            const { blackListIp, description } = req.body;
            this.ledger_storage.addBlacklist(blackListIp, description).then((data: any) => {
                if (data === undefined) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /addBlacklist`,
                        { endpoint: `/addBlacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(500).json('Failed to data lookup');
                } else if (data === true) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /addBlacklist`,
                        { endpoint: `/addBlacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(409).json('Ip already exist');
                } else {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`POST /addBlacklist`,
                        { endpoint: `/addBlacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(200).json(data);
                }
            })
            // const existBlacklist = await Blacklist.findOne({ ipAddress: blackListIp });
            // if (existBlacklist) {
            //     res.status(409).send('Ip already exist');
            //     let resTime: any = new Date().getTime() - time;
            //     logger.http(`POST /addBlacklist`, { endpoint: `/addBlacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            //     return;
            // }
            // const newBlacklistIp = await Blacklist.create({
            //     ipAddress: blackListIp,
            //     description: description
            // });
            // if (!newBlacklistIp) {
            //     res.status(500).send("Interal server error");
            // }
            // res.status(200).json({ message: 'Ip added successfully', blackListIp });
            // let resTime: any = new Date().getTime() - time;
            // logger.http(`POST /addblacklist`, { endpoint: `/addblacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            // return { newBlacklistIp }
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    *   get all blacklisted ips
    */
    public async allBlacklist(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        let pagination: IPagination = await this.paginate(req, res);
        try {
            this.ledger_storage.getAllBlacklistIps(pagination.pageSize, pagination.page).then((data) => {
                if (data === undefined) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /blacklist`,
                        { endpoint: `/blacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(500).json('Failed to data lookup');
                } else if (data.length === 0) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /blacklist`,
                        { endpoint: `/blacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(400).json('No blacklisted ip found');
                } else {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /blacklist`,
                        { endpoint: `/blacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(200).json(data);
                }
            })
            // await Blacklist.find()
            //     .skip((pagination.page - 1) * pagination.page)
            //     .limit(pagination.pageSize)
            //     .exec((er: any, result: any) => {
            //         res.status(200).json(result);
            //         let resTime: any = new Date().getTime() - time;
            //         logger.http(`GET /blacklist`, { endpoint: `/blacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
            //     });
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    *   Add blacklist ip address to database
    */
    public async deleteBlacklist(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        const ips = req.body.ips
        try {
            this.ledger_storage.deleteBlacklist(ips).then((data) => {
                if (data === undefined ) {
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`DELETE /deleteblacklist`,
                        { endpoint: `/deleteblacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(500).json("Failed to data lookup");
                } else {                    
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`DELETE /deleteblacklist`,
                        { endpoint: `/deleteblacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                    return res.status(200).json({ message: 'Ip delete successfully', data });
                }
            })
            // const ips = req.body.ips
            // const len = ips.length
            // for (let i = 0; i < len; i++) {
            //     const { blacklistIp } = ips[i]
            //     await Blacklist.findOneAndRemove({ ipAddress: blacklistIp }).then((res) => {
            //         deletedIps.push(res?.ipAddress)
            //     })
            // }
            // res.status(200).json({ message: 'Ip delete successfully', deletedIps });
            // let resTime: any = new Date().getTime() - time;
            // logger.http(`DELETE /deleteblacklist`, { endpoint: `/deleteblacklist`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });

        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    * search access logs
    */
    public async searchAccessLogs(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        let pagination: IPagination = await this.paginate(req, res);
        let ip = req.query.ip?.toString();
        let status = req.query.status?.toString();
        let endpoint = req.query.endpoint?.toString();
        let from = req.query.from;
        let to = req.query.to;
        let conditions = [];
        try {

            if (ip !== undefined)
                conditions.push({ 'meta.RequesterIP': ip })
            if (status !== undefined)
                conditions.push({ 'meta.accessStatus': status })
            if (endpoint !== undefined)
                conditions.push({ 'meta.endpoint': endpoint })
            if (from !== undefined && to !== undefined) {
                let fromDate = new Date(Number(from) * 1000);
                let toDate = new Date(Number(to) * 1000);

                conditions.push({ timestamp: { $gte: fromDate } })
                conditions.push({ timestamp: { $lte: toDate } })
            }
            let final_condition = conditions.length ? { $and: conditions } : {};
            let db = Logger.dbInstance
            db = db.connection.db
            await db.collection('access_logs').find(final_condition)
                .skip((pagination.page - 1) * pagination.page)
                .limit(pagination.pageSize)
                .toArray((er: any, result: any) => {


                    res.status(200).json(result);
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /accesslogs/search`, { endpoint: `/accesslogs/search`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                });
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
    * search operation logs
    */
    public async searchOperationLogs(req: express.Request, res: express.Response): Promise<any> {
        let time: any = new Date().getTime();
        let pagination: IPagination = await this.paginate(req, res);
        let type = req.query.type?.toString();
        let height = req.query.height?.toString();
        let status = req.query.status?.toString();
        let from = req.query.from?.toString();
        let to = req.query.to?.toString();
        let conditions = [];

        try {

            if (type !== undefined)
                conditions.push({ 'meta.operation': type })
            if (height !== undefined)
                conditions.push({ 'meta.height': height })
            if (status !== undefined)
                conditions.push({ 'meta.success': status })
            if (from !== undefined && to !== undefined) {
                let fromDate = new Date(Number(from) * 1000);
                let toDate = new Date(Number(to) * 1000);
                conditions.push({ timestamp: { $gte: fromDate } })
                conditions.push({ timestamp: { $lte: toDate } })
            }
            let final_condition = conditions.length ? { $and: conditions } : {};
            let db = Logger.dbInstance
            db = db.connection.db

            await db.collection('operation_logs').find(final_condition)
                .skip((pagination.page - 1) * pagination.page)
                .limit(pagination.pageSize)
                .toArray((er: any, result: any) => {

                    res.status(200).json(result);
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`GET /operationlogs/search`, { endpoint: `/operationlogs/search`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                });
        }
        catch (error) {
            logger.error('Error', error);
        }
    };
    /**
      * Get Coin Market Cap for BOA.
      * @param req
      * @param res
      * @returns Returns Coin market cap.
    */
    private async getCoinMarketCap(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        this.ledger_storage.getCoinMarketcap().then((rows: any) => {
            if (rows[0]) {
                res.status(200).send(rows[0]);
                let resTime: any = new Date().getTime() - time;
                logger.http(`/coinmarketcap`, { endpoint: `/coinmarketcap`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                return
            }
            else {
                return res.status(204).send(`The data does not exist.`)
            }

        }).catch((err) => {
            logger.error("Failed to data lookup to the DB: " + err,
                { operation: Operation.db, height: HeightManager.height.toString(), success: false });
            res.status(500).send("Failed to data lookup");
        });
    }

    /**
     * Restores blocks from expected_height to height - 1 and saves recently received block.
     * @param block The recently received block data
     * @param height The height of the recently received block data
     * @param expected_height The height of the block to save
     * @returns Returns the Promise. If it is finished successfully the `.then`
     * of the returned Promise is called
     * and if an error occurs the `.catch` is called with an error.
     */
    private recoverBlock(block: any, height: Height, expected_height: Height): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            (async () => {
                try {
                    let max_blocks = JSBI.add(
                        JSBI.subtract(height.value, expected_height.value),
                        block == null ? JSBI.BigInt(1) : JSBI.BigInt(0)
                    );

                    if (JSBI.greaterThan(max_blocks, JSBI.BigInt(this._max_count_on_recovery)))
                        max_blocks = JSBI.BigInt(this._max_count_on_recovery);

                    if (JSBI.greaterThan(max_blocks, JSBI.BigInt(0))) {
                        let blocks = await this.agora.getBlocksFrom(expected_height, Number(max_blocks));

                        // Save previous block
                        for (let block of blocks) {
                            if (JSBI.equal(block.header.height.value, expected_height.value)) {
                                await this.ledger_storage.putBlocks(block);
                                await this.emitBlock(block);
                                await this.emitBoaStats();
                                expected_height.value = JSBI.add(expected_height.value, JSBI.BigInt(1));
                                HeightManager.height = new Height(block.header.height.toString());
                                logger.info(
                                    `Recovered a block with block height of ${block.header.height.toString()}`,
                                    {
                                        operation: Operation.block_recovery,
                                        height: HeightManager.height.toString(),
                                        success: true,
                                    }
                                );
                            } else {
                                resolve(false);
                                return;
                            }
                        }
                    }

                    // Save a block just received
                    if (JSBI.lessThanOrEqual(height.value, expected_height.value)) {
                        if (block != null) {
                            await this.ledger_storage.putBlocks(Block.reviver("", block));
                            HeightManager.height = new Height(block.header.height.toString());
                            logger.info(`Saved a block with block height of ${height.toString()}`, {
                                operation: Operation.block_sync,
                                height: HeightManager.height.toString(),
                                success: true,
                            });
                        }
                        resolve(true);
                    } else {
                        HeightManager.height = new Height(block.header.height.toString());
                        logger.info(`Save of block ${height.toString()} postponed to`, {
                            operation: Operation.block_sync,
                            height: HeightManager.height.toString(),
                            success: true,
                        });
                        resolve(false);
                    }
                } catch (err) {
                    reject(err);
                }
            })();
        });
    }

    /**
     * Process pending data and put it into the storage.
     *
     * This function will take care of querying Agora if some blocks are missing.
     * It is separate from the actual handler as we don't want to suffer timeout
     * on the connection, hence we reply with a 200 before the info is stored.
     * This also means that we need to store data serially, in the order it arrived,
     * hence the `pending: Promise<void>` member acts as a queue.
     *
     * @returns A new `Promise<void>` for the caller to chain with `pending`.
     */
    private task(stored_data: IPooledData): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            if (stored_data === undefined) {
                resolve();
                return;
            }

            if (stored_data.type === "block") {
                let block = stored_data.data;

                try {
                    let height = Stoa.getJsonBlockHeight(block);
                    let expected_height = await this.ledger_storage.getExpectedBlockHeight();

                    if (JSBI.equal(height.value, expected_height.value)) {
                        // The normal case
                        // Save a block just received
                        await this.ledger_storage.putBlocks(Block.reviver("", block));
                        HeightManager.height = new Height(height.toString());
                        logger.info(`Saved a block with block height of ${height.toString()}`, {
                            operation: Operation.db,
                            height: HeightManager.height.toString(),
                            success: true,
                        });
                        await this.emitBlock(block);
                        await this.emitBoaStats();
                    } else if (JSBI.greaterThan(height.value, expected_height.value)) {
                        // Recovery is required for blocks that are not received.
                        while (true) {
                            if (await this.recoverBlock(block, height, expected_height)) break;
                            expected_height = await this.ledger_storage.getExpectedBlockHeight();
                        }
                    } else {
                        // Do not save because it is already a saved block.
                        logger.info(`Ignored a block with block height of ${height.toString()}`, {
                            operation: Operation.block_recovery,
                            height: HeightManager.height.toString(),
                            success: true,
                        });
                    }
                    resolve();
                } catch (err) {
                    logger.error("Failed to store the payload of a push to the DB: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        success: false,
                    });
                    reject(err);
                }
            } else if (stored_data.type === "pre_image") {
                try {
                    let pre_image = PreImageInfo.reviver("", stored_data.data);
                    let changes = await this.ledger_storage.updatePreImage(pre_image);

                    if (changes)
                        logger.info(
                            `Saved a pre-image utxo : ${pre_image.utxo.toString().substr(0, 18)}, ` +
                            `hash : ${pre_image.hash.toString().substr(0, 18)}, pre-image height : ${pre_image.height
                            }`,
                            {
                                operation: Operation.db,
                                height: HeightManager.height.toString(),
                                success: true,
                            }
                        );
                    resolve();
                } catch (err) {
                    logger.error("Failed to store the payload of a update to the DB: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        success: false,
                    });
                    reject(err);
                }
            } else if (stored_data.type === "transaction") {
                try {
                    let tx = Transaction.reviver("", stored_data.data);
                    let changes = await this.ledger_storage.putTransactionPool(tx);
                    let height = await this.agora.getBlockHeight();

                    if (changes)
                        logger.info(
                            `Saved a transaction hash : ${hashFull(tx).toString()}, ` + `data : ` + stored_data.data,
                            {
                                operation: Operation.db,
                                height: HeightManager.height.toString(),
                                success: true,
                            }
                        );
                    resolve();
                } catch (err) {
                    logger.error("Failed to store the payload of a push to the DB: " + err, {
                        operation: Operation.db,
                        height: HeightManager.height.toString(),
                        success: false,
                    });
                    reject(err);
                }
            }
        });
    }

    /**
     * Catches up to block height of Agora
     * This is done only once immediately after Stoa is executed.
     * @param height The block height of Agora
     */
    private catchup(height: Height): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            try {
                let expected_height = await this.ledger_storage.getExpectedBlockHeight();

                if (JSBI.greaterThanOrEqual(height.value, expected_height.value)) {
                    while (true) {
                        if (await this.recoverBlock(null, height, expected_height)) break;
                        // If the number of blocks to be recovered is too large,
                        // only a part of them will be recovered.
                        // Therefore, the height of the block to start the recovery
                        // is taken from the database.
                        expected_height = await this.ledger_storage.getExpectedBlockHeight();
                    }
                }

                resolve();
            } catch (err) {
                logger.error("Failed to catch up to block height of Agora: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                reject(err);
            }
        });
    }

    private paginate(req: express.Request, res: express.Response): Promise<IPagination> {
        return new Promise<IPagination>((resolve, reject) => {
            let page: number;
            let pageSize: number;

            if (req.query.page !== undefined && Number(req.query.page) !== 0) {
                if (!Utils.isPositiveInteger(req.query.page.toString())) {
                    res.status(400).send(`Invalid value for parameter 'page': ${req.query.page.toString()}`);
                    return;
                }
                page = Number(req.query.page.toString());
            } else page = 1;

            if (req.query.pageSize !== undefined) {
                if (!Utils.isPositiveInteger(req.query.pageSize.toString())) {
                    res.status(400).send(`Invalid value for parameter 'limit': ${req.query.pageSize.toString()}`);
                    return;
                }
                pageSize = Number(req.query.pageSize.toString());
                if (pageSize > this.limit_page_size) {
                    res.status(400).send(`Page size cannot be a number greater than 100: ${pageSize}`);
                    return;
                }
            } else pageSize = 10;

            return resolve({ page, pageSize });
        });
    }

    /**
     * GET /coinmarketchart/
     *
     * Called when a request is received through the `/utxo/` handler
     *
     * Returns BOA statistics of last 24 hours.
     */
    private async getBoaPriceChart(req: express.Request, res: express.Response) {
        let time: any = new Date().getTime();
        let to = await Time.msToTime(Date.now());
        let from = await JSBI.subtract(JSBI.BigInt(to.seconds), JSBI.BigInt(60 * 60 * 24));
        let num = Number(from.toString());

        let dt = new Date(to.seconds * 1000);
        let df = new Date(num * 1000);

        logger.info(`Price chart from: ${df}, to: ${dt} `, {
            operation: Operation.coin_market_data_sync,
            height: HeightManager.height.toString(),
            success: true,
        });

        this.ledger_storage
            .getCoinMarketChart(Number(from.toString()), to.seconds)
            .then(async (rows: any[]) => {
                if (rows.length === 0) {
                    res.status(204).send("The data does not exist");
                } else {
                    let marketCapChart: Array<IMarketChart> = [];
                    await rows.forEach((element, index) => {
                        marketCapChart.push({
                            usd_price: element.price,
                            last_updated_at: element.last_updated_at,
                        });
                    });
                    res.status(200).send(marketCapChart);
                    let resTime: any = new Date().getTime() - time;
                    logger.http(`/coinmarketchart`, { endpoint: `/coinmarketchart`, RequesterIP: req.ip, protocol: req.protocol, httpStatusCode: res.statusCode, userAgent: req.headers['user-agent'], accessStatus: res.statusCode !== 200 ? 'Denied' : 'Granted', bytesTransmitted: res.socket?.bytesWritten, responseTime: resTime });
                }
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err, {
                    operation: Operation.db,
                    height: HeightManager.height.toString(),
                    success: false,
                });
                res.send(500).send("Failed to data lookup");
            });
    }

    /**
     *  Stoa emits the latest Boa stats using sockets on new block received.
     * @returns Returns the Promise. If it is finished successfully the `.then`
     * of the returned Promise is called
     * and if an error occurs the `.catch` is called with an error.
     */
    public emitBoaStats(): Promise<IBOAStats> {
        return new Promise<IBOAStats>(async (resolve, reject) => {
            this.ledger_storage
                .getBOAStats()
                .then((data: any[]) => {
                    if (!data[0]) {
                        logger.info("Failed to latest BOA stats");
                        return;
                    } else {
                        let boaStats: IBOAStats = {
                            height: data[0].height,
                            transactions: data[0].transactions,
                            validators: data[0].validators,
                            frozen_coin: 5283595, //FIX ME static data because of unavailability of real data
                            circulating_supply: 5283535,
                            active_validators: 155055,
                        };
                        this.socket.io.emit(events.server.latestStats, boaStats);
                        logger.info(`Emitted Updated BOA stats:  ${boaStats}`);
                        return resolve(boaStats);
                    }
                })
                .catch((err) => {
                    logger.error("Failed to latest BOA stats: " + err);
                    return;
                });
        });
    }

    /**
     *  Stoa emits the updates using sockets on new block received
     * @param block The block to emit
     * @returns Returns the Promise. If it is finished successfully the `.then`
     * of the returned Promise is called
     * and if an error occurs the `.catch` is called with an error.
     */
    public emitBlock(block: Block): Promise<boolean> {
        return new Promise<boolean>(async (resolve, reject) => {
            try {
                await this.emitNewBlock(block);
                await this.emitBlockTransactions(block);
                resolve(true);
            } catch (err) {
                reject("Failed to emit new block");
            }
        });
    }

    /**
     * Stoa emits the detail of new block received
     * @param block
     * @returns
     */
    public emitNewBlock(block: Block): Promise<IEmitBlock> {
        return new Promise<IEmitBlock>((resolve, reject) => {
            let block_hash = hashFull(block.header);
            let latestBlock: IEmitBlock = {
                height: block.header.height.toString(),
                hash: block_hash.toString(),
                time_stamp: block.header.time_offset + this.genesis_timestamp,
                block: block,
            };
            logger.info(`Emitted new Block: ${latestBlock}`);
            this.socket.io.emit(events.server.newBlock, latestBlock);
            return resolve(latestBlock);
        });
    }

    /**
     * Stoa emit the transaction inside the new block received.
     * @param block
     * @returns
     */
    public emitBlockTransactions(block: Block): Promise<IEmitTransaction[]> {
        return new Promise<IEmitTransaction[]>(async (resolve, reject) => {
            let block_hash = hashFull(block.header);
            let blockTransactions: Array<IEmitTransaction> = [];

            for (let tx_idx = 0; tx_idx < block.txs.length; tx_idx++) {
                let EmitTransaction: IEmitTransaction = {
                    height: block.header.height.toString(),
                    hash: block_hash.toString(),
                    tx_hash: block.merkle_tree[tx_idx].toString(),
                    transaction: block.txs[tx_idx],
                };
                blockTransactions.push(EmitTransaction);
            }
            logger.info(`Emitted new Transactions: ${blockTransactions}`);
            this.socket.io.emit(events.server.newTransaction, blockTransactions);
            return resolve(blockTransactions);
        });
    }
    /* Get BOA Holders
     * @returns Returns BOA Holders of the ledger.
     */
    public async getBoaHolders(req: express.Request, res: express.Response) {

        logger.http(`GET /holders`);

        let pagination: IPagination = await this.paginate(req, res);
        this.ledger_storage.getBOAHolders(pagination.pageSize, pagination.page)
            .then((data: any[]) => {
                if (data.length === 0) {
                    return res.status(204).send(`The data does not exist.`);
                }
                else {
                    let holderList: Array<IBOAHolder> = [];
                    for (const row of data) {
                        holderList.push(
                            {
                                address: row.address,
                                tx_count: row.tx_count,
                                total_received: row.total_received,
                                total_sent: row.total_sent,
                                total_reward: row.total_reward,
                                total_frozen: row.total_frozen,
                                total_spendable: row.total_spendable,
                                total_balance: row.total_balance,
                            });
                    }
                    return res.status(200).send(JSON.stringify(holderList));
                }
            })
            .catch((err) => {
                logger.error("Failed to data lookup to the DB: " + err);
                return res.status(500).send("Failed to data lookup");
            })
    }

    /**
     * Get the maximum number of blocks that can be recovered at one time
     */
    get max_count_on_recovery(): number {
        return this._max_count_on_recovery;
    }

    /**
     * Set the maximum number of blocks that can be recovered at one time
     */
    set max_count_on_recovery(value: number) {
        this._max_count_on_recovery = value;
    }
}

/**
 * The interface of the data that are temporarily stored in the pool
 */
interface IPooledData {
    type: string;
    data: any;
}

export default Stoa;
