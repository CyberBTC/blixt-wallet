import { DeviceEventEmitter } from "react-native";
import { Action, action, computed, Computed, Thunk, thunk } from "easy-peasy";
import { generateSecureRandom } from "react-native-securerandom";

import { IStoreInjections } from "./store";
import { bytesToHexString, stringToUint8Array } from "../utils";
import { IStoreModel } from "./index";
import { Chain } from "../utils/build";

import logger from "./../utils/log";
const log = logger("BlixtLsp");

const ONDEMAND_CHANNEL_API = Chain === "regtest"
 ? "http://192.168.1.111:8080/ondemand-channel/"
 : "http://blixtwallet.ddns.net:8080/ondemand-channel/";

type Pubkey = string;
type ChannelId = Long;
type UserState = "NOT_REGISTERED" | "REGISTERED" | "WAITING_FOR_SETTLEMENT";

export interface IErrorResponse {
  status: "ERROR";
  reason: string;
}

export interface IOnDemandChannelServiceStatusResponse {
  status: boolean;
  approxFeeSat: number;
  minimumPaymentSat: number;
  peer: string;
}

export interface IOnDemandChannelRegisterRequest {
  pubkey: string;
  signature: string; // Message has to be REGISTER base64
  preimage: string;
  amountSat: number;
}

export interface IOnDemandChannelRegisterOkResponse {
  status: "OK";
  servicePubkey: string;
  fakeChannelId: string;
  cltvExpiryDelta: number;
  feeBaseMsat: number;
  feeProportionalMillionths: number;
}

export interface IOnDemandChannelCheckStatusRequest {
  pubkey: string;
  signature: string;
}

export interface IOnDemandChannelCheckStatusResponse {
  state: UserState;
}

export interface IOnDemandChannelRegisterErrorResponse extends IErrorResponse {}
export interface IOnDemandChannelUnknownRequestResponse extends IErrorResponse {}

export interface IOndemandChannel {
  checkOndemandChannelService: Thunk<IOndemandChannel, void, IStoreInjections>;
  addInvoice: Thunk<IOndemandChannel, { sat: number; description: string }, IStoreInjections, IStoreModel>;

  serviceStatus: Thunk<IOndemandChannel, void, IStoreInjections, {}, Promise<IOnDemandChannelServiceStatusResponse>>;
  checkStatus: Thunk<IOndemandChannel, void, IStoreInjections, IStoreModel, Promise<IOnDemandChannelServiceStatusResponse>>;
  register: Thunk<IOndemandChannel, { preimage: Uint8Array; amount: number; }, IStoreInjections, IStoreModel, Promise<IOnDemandChannelRegisterOkResponse>>;

  registerInvoicePreimage: Uint8Array | null;
  setRegisterInvoicePreimage: Action<IOndemandChannel, Uint8Array | null>;

  setStatus: Action<IOndemandChannel, IOnDemandChannelServiceStatusResponse | null>;

  status: IOnDemandChannelServiceStatusResponse | null;
  serviceActive: Computed<IOndemandChannel, boolean>;
}

export interface IBlixtLsp {
  initialize: Thunk<IBlixtLsp, void, IStoreInjections, IStoreModel>;

  // On-demand Channels
  ondemandChannel: IOndemandChannel;
};

export const blixtLsp: IBlixtLsp = {
  initialize: thunk(async (actions, _, { injections, getState, getStoreState, getStoreActions }) => {
    log.d("Initializing");

    // Excpet subscription to be started in Channel store
    DeviceEventEmitter.addListener("SubscribeChannelEvents", async (e: any) => {
      log.d("SubscribeChannelEvents");
      if (e.data === "") {
        log.i("Got e.data empty from SubscribeChannelEvent. Skipping event");
        return;
      }

      // const decodeChannelEvent = injections.lndMobile.channel.decodeChannelEvent;
      // const channelEvent = decodeChannelEvent(e.data);

      // This code isn't very good:
      const registerInvoicePreimage = getState().ondemandChannel.registerInvoicePreimage;
      if (registerInvoicePreimage) {
        log.d("Has registerInvoicePreimage");
        const tx = getStoreState().transaction.getTransactionByPreimage(registerInvoicePreimage);
        if (!tx) {
          log.e("Couldn't find transaction while atttempting to settle BlixtLSP invoice", [tx]);
          return;
        }
        tx.status = "SETTLED";
        getStoreActions().transaction.syncTransaction(tx);
        log.i("tx should be synced");
        actions.ondemandChannel.setRegisterInvoicePreimage(null);
      }
    });
  }),

  ondemandChannel: {
    checkOndemandChannelService: thunk(async (actions, _, { injections, getState, getStoreState, getStoreActions }) => {
      try {
        const serviceStatus = await actions.serviceStatus();
        actions.setStatus(serviceStatus);
      } catch (error) {
        log.w("checkOndemandChannelService failed", [error]);
        actions.setStatus(null);
      }
    }),
    // Requests
    serviceStatus: thunk(async (_, _2) => {
      log.i("serviceStatus");
      return (await fetch(`${ONDEMAND_CHANNEL_API}service-status`)).json();
    }),

    checkStatus: thunk(async (_, _2, { getStoreState, injections }) => {
      log.i("checkStatus");
      const signMessageResult = await injections.lndMobile.wallet.signMessageNodePubkey(stringToUint8Array("CHECKSTATUS"));

      const request = JSON.stringify({
        pubkey: getStoreState().lightning.nodeInfo?.identityPubkey,
        signature: signMessageResult.signature,
      });

      return (await fetch(`${ONDEMAND_CHANNEL_API}check-status`, {
        body: request,
        method: "POST",
      })).json();
    }),

    addInvoice: thunk((async (actions, { sat, description }, { getStoreActions }) => {
      const preimage = await generateSecureRandom(32);
      const result = await actions.register({
        preimage,
        amount: sat,
      });
      console.log(result);

      const invoice = await getStoreActions().receive.addInvoiceBlixtLsp({
        sat,
        preimage,
        chanId: result.fakeChannelId,
        cltvExpiryDelta: result.cltvExpiryDelta,
        feeBaseMsat: result.feeBaseMsat,
        feeProportionalMillionths: result.feeProportionalMillionths,
        description,
        servicePubkey: result.servicePubkey,
      });
      console.log(invoice);
      return invoice;
    })),

    register: thunk(async (actions, { preimage, amount }, { getStoreState, injections }) => {
      log.i("register");
      const signMessageResult = await injections.lndMobile.wallet.signMessageNodePubkey(stringToUint8Array("REGISTER"));
      // const getInfoResponse = await injections.lndMobile.index.getInfo();
      const request: IOnDemandChannelRegisterRequest = {
        pubkey: getStoreState().lightning.nodeInfo?.identityPubkey!,
        signature: signMessageResult.signature,
        preimage: bytesToHexString(preimage),
        amountSat: amount,
      };

      actions.setRegisterInvoicePreimage(preimage);

      const result = await fetch(`${ONDEMAND_CHANNEL_API}register`, {
        body: JSON.stringify(request),
        method: "POST",
      });
      const json = await result.json();
      if (json.status === "ERROR") {
        throw new Error(json.reason);
      }
      return json;
    }),

    setRegisterInvoicePreimage: action((store, payload) => {
      store.registerInvoicePreimage = payload;
    }),

    setStatus: action((store, payload) => {
      store.status = payload;
    }),

    registerInvoicePreimage: null,
    status: null,
    serviceActive: computed((store) => store.status?.status === true),
  },
};
