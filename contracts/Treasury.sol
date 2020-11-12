pragma solidity ^0.6.0;

import "./interfaces/IBasisAsset.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IOracle.sol";
import "./interfaces/IBoardroom.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "./lib/Babylonian.sol";
import "./lib/FixedPoint.sol";
import "./lib/Safe112.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Basis Cash Treasury contract
 * @notice Monetary policy logic to adjust supplies of basis cash assets
 * @author Summer Smith & Rick Sanchez
 */
contract Treasury is ReentrancyGuard, Ownable {
    using FixedPoint for *;
    using SafeERC20 for IERC20;
    using Address for address;
    using SafeMath for uint256;
    using Safe112 for uint112;

    /* ========== STATE VARIABLES ========== */

    address private cash;
    address private bond;
    address private share;
    address private cashOracle;
    address private multidai;
    address private boardroom;

    uint256 startTime = 1605163708; // TBD
    uint256 cashPriceCeiling;
    uint256 cashPriceOne;
    uint256 private bondDepletionFloor;
    uint256 private lastAllocated;

    /* ========== CONSTRUCTOR ========== */

    constructor(
        address _cash,
        address _bond,
        address _share,
        address _cashOracle,
        address _multidai,
        address _boardroom
    ) public {
        cash = _cash;
        bond = _bond;
        share = _share;
        cashOracle = _cashOracle;
        multidai = _multidai;
        boardroom = _boardroom;

        uint256 one = 1e18;
        cashPriceCeiling = FixedPoint
            .uq112x112(uint224(0x000000000000010500000000))
            .mul(one)
            .decode144();
        cashPriceOne = FixedPoint
            .uq112x112(uint224(0x000000000000010000000000))
            .mul(one)
            .decode144();

        // Set the depletion threshold of the treasury to 1000 basis cash
        bondDepletionFloor = 1000e18;
        lastAllocated = now;
    }

    // ========== EXTERNAL SETTERS ==========

    function setCash(address _cash) external onlyOwner {
        cash = _cash;
    }

    function setBond(address _bond) external onlyOwner {
        cash = _bond;
    }

    function setShare(address _share) external onlyOwner {
        cash = _share;
    }

    function setCashOracle(address _cashOracle) external onlyOwner {
        cashOracle = _cashOracle;
    }

    function setMultiDai(address _multidai) external onlyOwner {
        multidai = _multidai;
    }

    function setBoardroom(address _boardroom) external onlyOwner {
        boardroom = _boardroom;
    }

    /* ========== MODIFIERS ========== */

    modifier allocationTimeRipe {
        require(
            now.sub(lastAllocated) >= 1 days,
            "allocationTimeRipe: a day has not passed yet"
        );
        _;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function getCashPrice() internal returns (uint256 cashPrice) {
        try IOracle(cashOracle).update()  {} catch {
            revert("Treasury: failed to update cash oracle");
        }
        try IOracle(cashOracle).consult(cash, 1e18) returns (uint256 price) {
            return price;
        } catch {
            revert("Treasury: failed to consult cash price from the oracle");
        }
    }

    /**
     * @notice Buy bonds from the system.
     * @param amount amount of cash to purchase bonds with.
     */
    function buyBonds(uint256 amount) external {
        // get input price from 1 multidai to basis cash
        uint256 cashPrice = getCashPrice();

        // Cash can be swapped to bonds at (price of basis cash) * amount
        uint256 bondPrice = cashPrice;

        // Check the operator of burning cash
        require(
            IBasisAsset(cash).operator() == address(this),
            "Treasury: this contract is not the operator of the basis cash contract"
        );

        IBasisAsset(cash).burnFrom(msg.sender, amount);
        IBasisAsset(bond).mint(msg.sender, amount.mul(1e18).div(bondPrice));

        emit BoughtBonds(msg.sender, amount);
    }

    /**
     * @notice Redeem bonds for cash.
     * @param amount amount of bonds to redeem.
     */
    function redeemBonds(uint256 amount) external {
        // get input price from 1 multidai to basis cash
        uint256 cashPrice = getCashPrice();

        require(
            cashPrice >= cashPriceOne,
            "Treasury: bond redemption failed; basis cash remains depegged."
        );

        // Check the operator of burning bond
        require(
            IBasisAsset(bond).operator() == address(this),
            "Treasury: this contract is not the operator of the basis bond contract"
        );

        // Burn basis bonds
        IBasisAsset(bond).burnFrom(msg.sender, amount);
        IBasisAsset(cash).mint(msg.sender, amount);

        emit RedeemedBonds(msg.sender, amount);
    }

    /**
     * @notice Expansionary monetary policy. Called at most once a day.
     */
    function allocateSeigniorage() external allocationTimeRipe {
        require(block.timestamp > startTime, "Treasury: not started yet");

        // get input price from 1 multidai to basis cash
        uint256 cashPrice = getCashPrice();

        require(
            cashPrice > cashPriceCeiling,
            "Treasury: there is no seigniorage to be allocated"
        );

        uint256 cashSupply = IERC20(cash).totalSupply();
        uint256 seigniorage = cashSupply.mul(cashPrice.sub(cashPriceOne));
        uint256 treasuryBalance = IERC20(cash).balanceOf(address(this));

        // If the treasury is sufficiently capitalized, pay dividends to shareholders
        if (treasuryBalance > bondDepletionFloor) {
            IBasisAsset(cash).mint(address(this), seigniorage);
            IBoardroom(boardroom).allocateSeigniorage(seigniorage);
            emit BoardroomFunded(now, seigniorage);
        } else {
            // replenish the treasury otherwise
            IBasisAsset(cash).mint(address(this), seigniorage);
            emit TreasuryFunded(now, seigniorage);
        }

        // reinitialize seigniorageLastAllocated
        lastAllocated = now;
    }

    /* ========== EVENTS ========== */

    event RedeemedBonds(address indexed from, uint256 amount);
    event BoughtBonds(address indexed from, uint256 amount);
    event TreasuryFunded(uint256 timestamp, uint256 seigniorage);
    event BoardroomFunded(uint256 timestamp, uint256 seigniorage);
}
