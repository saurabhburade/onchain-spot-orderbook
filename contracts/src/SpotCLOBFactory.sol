// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolRegistry } from "./IPoolRegistry.sol";
import { ISpotCLOBFactory } from "./ISpotCLOBFactory.sol";
import { SpotCLOB } from "./SpotCLOB.sol";
import { SpotPriceMath } from "./libraries/SpotPriceMath.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @notice Deploys and indexes one independent spot CLOB for each ordered base/quote pair.
/// @dev Pair creation is permissionless, but the owner controls which quote assets new pairs may
/// use and the lot precision applied to each pair.
contract SpotCLOBFactory is ISpotCLOBFactory {
    error Unauthorized();
    error InvalidPair();
    error InvalidLotDecimals(uint8 lotDecimals, uint8 tokenDecimals);
    error LotSizeOverflow(uint8 tokenDecimals, uint8 lotDecimals);
    error QuoteTokenNotAllowed(address token);
    error PairAlreadyExists(bytes32 pairId);
    error PairIndexOutOfBounds(uint256 index);
    error TradingFeeTooHigh(uint16 tradingFeeBps);
    error IncorrectMarketCreationFee(uint256 required, uint256 provided);
    error InvalidRecipient();
    error NativeTransferFailed();
    error BookDeploymentFailed();

    uint16 public constant MAX_TRADING_FEE_BPS = 1_000;
    address public immutable owner;
    address public immutable bookImplementation;
    uint8 public defaultLotDecimals = 8;
    uint16 public defaultTradingFeeBps = 10;
    uint256 public marketCreationFee;
    mapping(address token => bool allowed) public isQuoteToken;

    struct PairConfig {
        address baseAsset;
        address quoteAsset;
        uint128 lotSize;
        uint8 lotDecimals;
        uint128 tickSize;
        uint24 minTick;
        uint24 maxTick;
        uint16 tradingFeeBps;
        bool agnosticPricing;
    }

    mapping(bytes32 id => Pool pool) private _pools;
    mapping(bytes32 id => uint8 lotDecimals) private _pairLotDecimals;
    mapping(bytes32 id => bool configured) private _hasPairLotDecimals;
    bytes32[] private _pairIds;

    modifier onlyOwner() {
        _requireOwner();
        _;
    }

    function _requireOwner() private view {
        if (msg.sender != owner) revert Unauthorized();
    }

    constructor() {
        owner = msg.sender;
        bookImplementation = address(new SpotCLOB(IPoolRegistry(address(0))));
    }

    /// @notice Set the fallback base-token precision used by pairs without an explicit override.
    /// @dev If a token exposes fewer decimals, its full native precision is used instead.
    function setDefaultLotDecimals(uint8 lotDecimals) external onlyOwner {
        uint8 previousLotDecimals = defaultLotDecimals;
        defaultLotDecimals = lotDecimals;
        emit DefaultLotDecimalsUpdated(previousLotDecimals, lotDecimals);
    }

    function setDefaultTradingFeeBps(uint16 tradingFeeBps) external onlyOwner {
        _validateTradingFee(tradingFeeBps);
        uint16 previousFeeBps = defaultTradingFeeBps;
        defaultTradingFeeBps = tradingFeeBps;
        emit DefaultTradingFeeUpdated(previousFeeBps, tradingFeeBps);
    }

    /// @notice Set the native MON amount required to create a market.
    /// @dev The value is denominated in wei and defaults to zero.
    function setMarketCreationFee(uint256 newFee) external onlyOwner {
        uint256 previousFee = marketCreationFee;
        marketCreationFee = newFee;
        emit MarketCreationFeeUpdated(previousFee, newFee);
    }

    /// @notice Withdraw native MON collected from market creation.
    function withdrawMarketCreationFees(address payable recipient, uint256 amount)
        external
        onlyOwner
    {
        if (recipient == address(0)) revert InvalidRecipient();
        (bool success,) = recipient.call{ value: amount }("");
        if (!success) revert NativeTransferFailed();
        emit MarketCreationFeesWithdrawn(recipient, amount);
    }

    function setPairTradingFeeBps(address baseAsset, address quoteAsset, uint16 tradingFeeBps)
        external
        onlyOwner
    {
        _validateTradingFee(tradingFeeBps);
        bytes32 id = pairId(baseAsset, quoteAsset);
        Pool storage pool = _pools[id];
        if (!pool.exists) revert InvalidPair();
        uint16 previousFeeBps = pool.tradingFeeBps;
        pool.tradingFeeBps = tradingFeeBps;
        SpotCLOB(pool.book).setTradingFeeBps(id, tradingFeeBps);
        emit PairTradingFeeUpdated(id, previousFeeBps, tradingFeeBps);
    }

    /// @notice Override the tradable base-token precision for a pair before it is created.
    function setPairLotDecimals(address baseAsset, address quoteAsset, uint8 lotDecimals)
        external
        onlyOwner
    {
        _validateAssets(baseAsset, quoteAsset);
        bytes32 id = pairId(baseAsset, quoteAsset);
        if (_pools[id].exists) revert PairAlreadyExists(id);

        uint8 tokenDecimals = IERC20Decimals(baseAsset).decimals();
        if (lotDecimals > tokenDecimals) revert InvalidLotDecimals(lotDecimals, tokenDecimals);
        if (tokenDecimals - lotDecimals > 38) revert LotSizeOverflow(tokenDecimals, lotDecimals);

        _pairLotDecimals[id] = lotDecimals;
        _hasPairLotDecimals[id] = true;
        emit PairLotDecimalsUpdated(id, baseAsset, quoteAsset, lotDecimals);
    }

    /// @notice Remove a pre-creation pair override so the current default applies.
    function clearPairLotDecimals(address baseAsset, address quoteAsset) external onlyOwner {
        _validateAssets(baseAsset, quoteAsset);
        bytes32 id = pairId(baseAsset, quoteAsset);
        if (_pools[id].exists) revert PairAlreadyExists(id);

        delete _pairLotDecimals[id];
        delete _hasPairLotDecimals[id];
        emit PairLotDecimalsCleared(id, baseAsset, quoteAsset);
    }

    /// @notice Return the effective number of tradable decimal places for a pair.
    function pairLotDecimals(address baseAsset, address quoteAsset) public view returns (uint8) {
        _validateAssets(baseAsset, quoteAsset);
        bytes32 id = pairId(baseAsset, quoteAsset);
        if (_hasPairLotDecimals[id]) return _pairLotDecimals[id];
        uint8 tokenDecimals = IERC20Decimals(baseAsset).decimals();
        return defaultLotDecimals < tokenDecimals ? defaultLotDecimals : tokenDecimals;
    }

    /// @notice Return the raw base-token amount represented by one lot for a pair.
    function pairLotSize(address baseAsset, address quoteAsset) public view returns (uint128) {
        _validateAssets(baseAsset, quoteAsset);
        bytes32 id = pairId(baseAsset, quoteAsset);
        if (_pools[id].exists) return _pools[id].lotSize;
        uint8 tokenDecimals = IERC20Decimals(baseAsset).decimals();
        uint8 lotDecimals = _effectiveLotDecimals(id, tokenDecimals);
        return _lotSize(tokenDecimals, lotDecimals);
    }

    /// @notice Add or remove an asset from the quote-token allowlist for future pairs.
    /// @dev Removing a token does not disable pairs that already use it.
    function setQuoteToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert InvalidPair();
        isQuoteToken[token] = allowed;
        emit QuoteTokenUpdated(token, allowed);
    }

    /// @notice Return the ordered pair identifier. Base/quote order is significant.
    function pairId(address baseAsset, address quoteAsset) public pure returns (bytes32) {
        return keccak256(abi.encode(baseAsset, quoteAsset));
    }

    /// @notice Deploy a supply-agnostic order book with no creator-selected price profile.
    function createPair(address baseAsset, address quoteAsset)
        external
        payable
        returns (bytes32 id, address book)
    {
        return _createAgnosticPair(baseAsset, quoteAsset, defaultTradingFeeBps);
    }

    /// @notice Deploy a supply-agnostic order book with an explicit taker trading fee.
    function createPairWithFee(address baseAsset, address quoteAsset, uint16 tradingFeeBps)
        external
        payable
        returns (bytes32 id, address book)
    {
        _validateTradingFee(tradingFeeBps);
        return _createAgnosticPair(baseAsset, quoteAsset, tradingFeeBps);
    }

    /// @notice Deploy a deterministic order book for a base asset and an approved quote asset.
    function createPair(
        address baseAsset,
        address quoteAsset,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) external payable returns (bytes32 id, address book) {
        _validatePairParameters(baseAsset, quoteAsset, tickSize, minTick, maxTick);
        _requireMarketCreationFee();
        id = pairId(baseAsset, quoteAsset);
        uint8 tokenDecimals = IERC20Decimals(baseAsset).decimals();
        uint8 lotDecimals = _effectiveLotDecimals(id, tokenDecimals);
        uint128 lotSize = _lotSize(tokenDecimals, lotDecimals);

        return _createPair(
            id,
            PairConfig({
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                lotSize: lotSize,
                lotDecimals: lotDecimals,
                tickSize: tickSize,
                minTick: minTick,
                maxTick: maxTick,
                tradingFeeBps: defaultTradingFeeBps,
                agnosticPricing: false
            })
        );
    }

    /// @notice Deploy a deterministic order book with an explicit raw base-token lot size.
    /// @dev A lot may contain multiple whole base tokens. This lets one quote-token atom represent
    /// a per-token price below one quote-token atom without allowing sub-atom settlement.
    function createPair(
        address baseAsset,
        address quoteAsset,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) external payable returns (bytes32 id, address book) {
        _validatePairParameters(baseAsset, quoteAsset, tickSize, minTick, maxTick);
        _requireMarketCreationFee();
        if (lotSize == 0) revert InvalidPair();
        id = pairId(baseAsset, quoteAsset);

        // Explicit multi-token lots have no fractional tradable decimals. The raw lot size stored
        // in the pool remains the canonical sizing value.
        return _createPair(
            id,
            PairConfig({
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                lotSize: lotSize,
                lotDecimals: 0,
                tickSize: tickSize,
                minTick: minTick,
                maxTick: maxTick,
                tradingFeeBps: defaultTradingFeeBps,
                agnosticPricing: false
            })
        );
    }

    function createPairWithFee(
        address baseAsset,
        address quoteAsset,
        uint128 lotSize,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick,
        uint16 tradingFeeBps
    ) external payable returns (bytes32 id, address book) {
        _validatePairParameters(baseAsset, quoteAsset, tickSize, minTick, maxTick);
        _requireMarketCreationFee();
        _validateTradingFee(tradingFeeBps);
        if (lotSize == 0) revert InvalidPair();
        id = pairId(baseAsset, quoteAsset);
        return _createPair(
            id,
            PairConfig({
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                lotSize: lotSize,
                lotDecimals: 0,
                tickSize: tickSize,
                minTick: minTick,
                maxTick: maxTick,
                tradingFeeBps: tradingFeeBps,
                agnosticPricing: false
            })
        );
    }

    function _createAgnosticPair(address baseAsset, address quoteAsset, uint16 tradingFeeBps)
        private
        returns (bytes32 id, address book)
    {
        _validateAssets(baseAsset, quoteAsset);
        if (!isQuoteToken[quoteAsset]) revert QuoteTokenNotAllowed(quoteAsset);
        _requireMarketCreationFee();
        id = pairId(baseAsset, quoteAsset);
        return _createPair(
            id,
            PairConfig({
                baseAsset: baseAsset,
                quoteAsset: quoteAsset,
                lotSize: 0,
                lotDecimals: 0,
                tickSize: 0,
                minTick: 0,
                maxTick: 0,
                tradingFeeBps: tradingFeeBps,
                agnosticPricing: true
            })
        );
    }

    function _createPair(bytes32 id, PairConfig memory config)
        private
        returns (bytes32, address book)
    {
        if (_pools[id].exists) revert PairAlreadyExists(id);
        uint8 baseDecimals = IERC20Decimals(config.baseAsset).decimals();
        uint8 quoteDecimals = IERC20Decimals(config.quoteAsset).decimals();
        if (config.agnosticPricing) {
            // Fail during creation instead of leaving a market whose decimal relationship can
            // never be converted safely by the matching engine.
            SpotPriceMath.quoteDenominator(baseDecimals, quoteDecimals);
        }

        // Snapshot the effective precision so later default updates cannot alter pair metadata.
        _pairLotDecimals[id] = config.lotDecimals;
        _hasPairLotDecimals[id] = true;

        _pools[id] = Pool({
            baseAsset: config.baseAsset,
            quoteAsset: config.quoteAsset,
            book: address(0),
            lotSize: config.lotSize,
            tickSize: config.tickSize,
            minTick: config.minTick,
            maxTick: config.maxTick,
            tradingFeeBps: config.tradingFeeBps,
            baseDecimals: baseDecimals,
            quoteDecimals: quoteDecimals,
            agnosticPricing: config.agnosticPricing,
            exists: true
        });

        book = _cloneDeterministic(bookImplementation, id);
        SpotCLOB deployedBook = SpotCLOB(book);
        deployedBook.initialize(this);
        deployedBook.activatePool(id);
        _pools[id].book = book;
        _pairIds.push(id);

        emit PairCreated(
            id,
            config.baseAsset,
            config.quoteAsset,
            book,
            config.lotSize,
            config.tickSize,
            config.minTick,
            config.maxTick,
            config.tradingFeeBps
        );
        if (config.agnosticPricing) {
            emit AgnosticPricingConfigured(id, baseDecimals, quoteDecimals);
        }
        emit MarketCreationFeePaid(id, msg.sender, msg.value);
        return (id, book);
    }

    function _validatePairParameters(
        address baseAsset,
        address quoteAsset,
        uint128 tickSize,
        uint24 minTick,
        uint24 maxTick
    ) private view {
        if (
            baseAsset == address(0) || quoteAsset == address(0) || baseAsset == quoteAsset
                || tickSize == 0 || minTick == 0 || minTick > maxTick
                || uint256(tickSize) * maxTick > type(uint128).max
        ) revert InvalidPair();
        if (!isQuoteToken[quoteAsset]) revert QuoteTokenNotAllowed(quoteAsset);
    }

    function _validateTradingFee(uint16 tradingFeeBps) private pure {
        if (tradingFeeBps > MAX_TRADING_FEE_BPS) revert TradingFeeTooHigh(tradingFeeBps);
    }

    function _requireMarketCreationFee() private view {
        uint256 requiredFee = marketCreationFee;
        if (msg.value != requiredFee) revert IncorrectMarketCreationFee(requiredFee, msg.value);
    }

    function getPool(bytes32 id) external view returns (Pool memory) {
        return _pools[id];
    }

    function getPool(address baseAsset, address quoteAsset) external view returns (Pool memory) {
        return _pools[pairId(baseAsset, quoteAsset)];
    }

    function getPair(bytes32 id) external view returns (address) {
        return _pools[id].book;
    }

    function getPair(address baseAsset, address quoteAsset) external view returns (address) {
        return _pools[pairId(baseAsset, quoteAsset)].book;
    }

    function allPairsLength() external view returns (uint256) {
        return _pairIds.length;
    }

    function pairAt(uint256 index) external view returns (bytes32) {
        if (index >= _pairIds.length) revert PairIndexOutOfBounds(index);
        return _pairIds[index];
    }

    function predictPairAddress(address baseAsset, address quoteAsset)
        external
        view
        returns (address predicted)
    {
        bytes32 salt = pairId(baseAsset, quoteAsset);
        bytes32 initCodeHash = keccak256(_cloneCreationCode(bookImplementation));
        predicted = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))
                )
            )
        );
    }

    function _cloneDeterministic(address implementation, bytes32 salt)
        private
        returns (address instance)
    {
        bytes memory code = _cloneCreationCode(implementation);
        assembly ("memory-safe") {
            instance := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (instance == address(0)) revert BookDeploymentFailed();
    }

    function _cloneCreationCode(address implementation) private pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3",
            hex"363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    function _effectiveLotDecimals(bytes32 id, uint8 tokenDecimals) private view returns (uint8) {
        if (_hasPairLotDecimals[id]) return _pairLotDecimals[id];
        return defaultLotDecimals < tokenDecimals ? defaultLotDecimals : tokenDecimals;
    }

    function _lotSize(uint8 tokenDecimals, uint8 lotDecimals) private pure returns (uint128) {
        uint8 exponent = tokenDecimals - lotDecimals;
        if (exponent > 38) revert LotSizeOverflow(tokenDecimals, lotDecimals);
        return uint128(10 ** uint256(exponent));
    }

    function _validateAssets(address baseAsset, address quoteAsset) private pure {
        if (baseAsset == address(0) || quoteAsset == address(0) || baseAsset == quoteAsset) {
            revert InvalidPair();
        }
    }
}
