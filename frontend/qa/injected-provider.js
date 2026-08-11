/* PREDEX_QA_INJECTED_PROVIDER_V1
 *
 * QA-only EIP-1193 facade. This file is not imported by the Next application;
 * the loopback QA signer serves it only to a development-server build. The
 * private key never enters this source or the browser: signing happens in the
 * signer process that received QA_WALLET_PRIVATE_KEY at runtime.
 */
(function installPredexQaProvider(globalObject) {
  'use strict';

  var config = globalObject.__PREDEX_QA_WALLET_CONFIG__;
  delete globalObject.__PREDEX_QA_WALLET_CONFIG__;
  if (!config || typeof config !== 'object') {
    throw new Error('Predex QA wallet bootstrap configuration is missing.');
  }
  if (globalObject.ethereum !== undefined) {
    throw new Error('Predex QA wallet refuses to replace an existing provider.');
  }

  var READ_ONLY_ERROR =
    'QA wallet is in read-only mode; eth_sendTransaction is disabled and no transaction was broadcast.';
  var SUPPORTED_EVENTS = ['accountsChanged', 'chainChanged', 'connect', 'disconnect'];

  function ProviderRpcError(code, message, data) {
    var error = new Error(message);
    error.name = 'ProviderRpcError';
    error.code = code;
    if (data !== undefined) error.data = data;
    return error;
  }

  function assertArcChain(params) {
    var requested = params && params[0] && params[0].chainId;
    if (typeof requested !== 'string' || requested.toLowerCase() !== config.chainIdHex) {
      throw ProviderRpcError(4902, 'The QA wallet supports Arc testnet only.');
    }
  }

  function QaEthereumProvider() {
    this.isPredexQaWallet = true;
    this._listeners = new Map();
  }

  QaEthereumProvider.prototype.isConnected = function isConnected() {
    return true;
  };

  QaEthereumProvider.prototype.on = function on(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Provider event listener must be a function.');
    }
    var listeners = this._listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(event, listeners);
    }
    listeners.add(listener);
    return this;
  };

  QaEthereumProvider.prototype.addListener = QaEthereumProvider.prototype.on;

  QaEthereumProvider.prototype.removeListener = function removeListener(event, listener) {
    var listeners = this._listeners.get(event);
    if (listeners) listeners.delete(listener);
    return this;
  };

  QaEthereumProvider.prototype.removeAllListeners = function removeAllListeners(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
    return this;
  };

  QaEthereumProvider.prototype.emit = function emit(event) {
    if (SUPPORTED_EVENTS.indexOf(event) === -1) return false;
    var listeners = this._listeners.get(event);
    if (!listeners || listeners.size === 0) return false;
    var args = Array.prototype.slice.call(arguments, 1);
    listeners.forEach(function callListener(listener) {
      listener.apply(undefined, args);
    });
    return true;
  };

  QaEthereumProvider.prototype._signerRequest = async function signerRequest(method, params) {
    var response = await globalObject.fetch(config.rpcUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-predex-qa-token': config.token,
      },
      body: JSON.stringify({ method: method, params: params || [] }),
      credentials: 'omit',
      cache: 'no-store',
    });
    var body;
    try {
      body = await response.json();
    } catch {
      throw ProviderRpcError(-32603, 'The local QA wallet returned an invalid response.');
    }
    if (!response.ok || body.error) {
      var rpcError = body && body.error;
      throw ProviderRpcError(
        rpcError && Number.isInteger(rpcError.code) ? rpcError.code : -32603,
        rpcError && typeof rpcError.message === 'string'
          ? rpcError.message
          : 'The local QA wallet request failed.',
        rpcError && rpcError.data,
      );
    }
    return body.result;
  };

  QaEthereumProvider.prototype.request = async function request(args) {
    if (!args || typeof args.method !== 'string') {
      throw ProviderRpcError(-32600, 'Provider request requires a method.');
    }
    var params = Array.isArray(args.params) ? args.params : [];
    switch (args.method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [config.account];
      case 'eth_coinbase':
        return config.account;
      case 'eth_chainId':
        return config.chainIdHex;
      case 'net_version':
        return String(config.chainId);
      case 'wallet_getPermissions':
      case 'wallet_requestPermissions':
        return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        assertArcChain(params);
        this.emit('chainChanged', config.chainIdHex);
        return null;
      case 'personal_sign':
      case 'eth_signTypedData_v4':
        return this._signerRequest(args.method, params);
      case 'eth_sendTransaction':
        // Reject in the browser before even contacting localhost. The signer
        // repeats this check as defense in depth.
        if (config.mode === 'read-only') {
          throw ProviderRpcError(4100, READ_ONLY_ERROR);
        }
        return this._signerRequest(args.method, params);
      default:
        throw ProviderRpcError(
          4200,
          'Predex QA wallet does not support RPC method ' + args.method + '.',
        );
    }
  };

  var provider = new QaEthereumProvider();
  Object.defineProperty(globalObject, 'ethereum', {
    configurable: true,
    enumerable: true,
    value: provider,
    writable: false,
  });
})(globalThis);
