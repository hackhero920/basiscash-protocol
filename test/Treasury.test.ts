import chai, { expect } from 'chai';
import { ethers } from 'hardhat';
import { solidity, MockProvider } from 'ethereum-waffle';
import { Contract, ContractFactory, BigNumber, utils } from 'ethers';
import { Provider, TransactionReceipt } from '@ethersproject/providers';

import { advanceTimeAndBlock } from './shared/utilities';

import UniswapV2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json';
import UniswapV2Router from '@uniswap/v2-periphery/build/UniswapV2Router02.json';

chai.use(solidity);

async function latestBlocktime(provider: Provider): Promise<number> {
  const { timestamp } = await provider.getBlock('latest');
  return timestamp;
}

describe('Treasury', () => {
  const provider = new MockProvider({
    ganacheOptions: {
      hardfork: 'istanbul',
      gasLimit: 9999999,
    },
  });

  const [operator, ant] = provider.getWallets();

  const ETH = utils.parseEther('1');
  const ZERO = BigNumber.from(0);

  // core
  let Bond: ContractFactory;
  let Cash: ContractFactory;
  let Share: ContractFactory;
  let Treasury: ContractFactory;
  let Boardroom: ContractFactory;
  let MockDAI: ContractFactory;
  let Oracle: ContractFactory;

  // uniswap
  let Factory = new ContractFactory(UniswapV2Factory.abi, UniswapV2Factory.bytecode);
  let Router = new ContractFactory(UniswapV2Router.abi, UniswapV2Router.bytecode);

  before('fetch contract factories', async () => {
    Bond = await ethers.getContractFactory('Bond');
    Cash = await ethers.getContractFactory('Cash');
    Share = await ethers.getContractFactory('Share');
    MockDAI = await ethers.getContractFactory('MockDai');
    Treasury = await ethers.getContractFactory('Treasury');
    Boardroom = await ethers.getContractFactory('Boardroom');
    Oracle = await ethers.getContractFactory('Oracle');
  });

  let factory: Contract;
  let router: Contract;

  before('deploy uniswap', async () => {
    factory = await Factory.connect(operator).deploy(operator.address);
    router = await Router.connect(operator).deploy(factory.address, operator.address);
  });

  let dai: Contract;
  let bond: Contract;
  let cash: Contract;
  let share: Contract;
  let oracle: Contract;
  let treasury: Contract;
  let boardroom: Contract;

  beforeEach('deploy contracts', async () => {
    dai = await MockDAI.connect(operator).deploy();
    bond = await Bond.connect(operator).deploy();
    cash = await Cash.connect(operator).deploy();
    share = await Share.connect(operator).deploy();

    await dai.connect(operator).mint(operator.address, ETH);
    await dai.connect(operator).approve(router.address, ETH);
    await cash.connect(operator).mint(operator.address, ETH);
    await cash.connect(operator).approve(router.address, ETH);

    await router
      .connect(operator)
      .addLiquidity(
        cash.address,
        dai.address,
        ETH,
        ETH,
        ETH,
        ETH,
        operator.address,
        (await latestBlocktime(provider)) + 1800
      );

    oracle = await Oracle.connect(operator).deploy(factory.address, cash.address, dai.address);
    boardroom = await Boardroom.connect(operator).deploy(cash.address, share.address);
    treasury = await Treasury.connect(operator).deploy(
      cash.address,
      bond.address,
      oracle.address,
      boardroom.address
    );
    await advanceTimeAndBlock(provider, Number(await oracle.PERIOD()));
  });

  describe('#allocateSeigniorage', () => {
    const swapAmount = ETH.sub(ETH.div(4));

    beforeEach('distribute tokens', async () => {
      await Promise.all([
        dai.connect(operator).mint(ant.address, swapAmount),
        dai.connect(ant).approve(router.address, swapAmount),
      ]);
    });

    it('should work correctly', async () => {
      await cash.connect(operator).transferOperator(treasury.address);
      await bond.connect(operator).transferOperator(treasury.address);

      await router
        .connect(ant)
        .swapExactTokensForTokens(
          swapAmount,
          ZERO,
          [dai.address, cash.address],
          ant.address,
          (await latestBlocktime(provider)) + 1800
        );
      await advanceTimeAndBlock(provider, Number(await treasury.allocationDelay()));

      await oracle.update();
      const cashPrice = await oracle.consult(cash.address, ETH);
      const cashSupply = await cash.totalSupply();
      const expectedSeigniorage = cashSupply.mul(cashPrice.sub(ETH)).div(ETH);

      const tx = await treasury.allocateSeigniorage();
      const blocktime = await latestBlocktime(provider);
      await expect(new Promise((resolve) => resolve(tx)))
        .to.emit(treasury, 'TreasuryFunded')
        .withArgs(blocktime, expectedSeigniorage);

      expect(await cash.balanceOf(treasury.address)).to.eq(expectedSeigniorage);
    });

    it("should funded to boardroom when contract's seigniorage budget exceeds depletion floor", async () => {
      await cash.connect(operator).mint(operator.address, ETH.mul(1000));
      await cash.connect(operator).transferOperator(treasury.address);
      await bond.connect(operator).transferOperator(treasury.address);

      await router
        .connect(ant)
        .swapExactTokensForTokens(
          swapAmount,
          ZERO,
          [dai.address, cash.address],
          ant.address,
          (await latestBlocktime(provider)) + 1800
        );
      await advanceTimeAndBlock(provider, Number(await treasury.allocationDelay()));
      await treasury.allocateSeigniorage();
      await advanceTimeAndBlock(provider, Number(await treasury.allocationDelay()));

      await oracle.update();
      const cashPrice = await oracle.consult(cash.address, ETH);
      const cashSupply = await cash.totalSupply();
      const expectedSeigniorage = cashSupply.mul(cashPrice.sub(ETH)).div(ETH);

      const tx = await treasury.allocateSeigniorage();
      const blocktime = await latestBlocktime(provider);
      await expect(new Promise((resolve) => resolve(tx)))
        .to.emit(treasury, 'BoardroomFunded')
        .withArgs(blocktime, expectedSeigniorage);

      expect(await cash.balanceOf(boardroom.address)).to.eq(expectedSeigniorage);
    });

    it('should fail if treasury is not the operator of cash contract', async () => {
      await bond.connect(operator).transferOperator(treasury.address);
      await expect(treasury.allocateSeigniorage()).to.revertedWith(
        'Treasury: this contract is not the operator of the basis cash contract'
      );
    });

    it('should fail if treasury is not the operator of bond contract', async () => {
      await cash.connect(operator).transferOperator(treasury.address);
      await expect(treasury.allocateSeigniorage()).to.revertedWith(
        'Treasury: this contract is not the operator of the basis bond contract'
      );
    });

    it('should fail when cash price is below $1+ε', async () => {
      await cash.connect(operator).transferOperator(treasury.address);
      await bond.connect(operator).transferOperator(treasury.address);

      await advanceTimeAndBlock(provider, Number(await treasury.allocationDelay()));

      await expect(treasury.allocateSeigniorage()).to.revertedWith(
        'Treasury: there is no seigniorage to be allocated'
      );
    });
  });

  describe('#buyBonds', () => {
    const purchaseAmount = ETH.mul(10);
    const swapAmount = ETH.div(4);

    beforeEach('distribute tokens', async () => {
      await cash.connect(operator).mint(ant.address, swapAmount.add(purchaseAmount));
      await cash.connect(operator).transferOperator(treasury.address);
      await bond.connect(operator).transferOperator(treasury.address);
    });

    it('should work correctly', async () => {
      await oracle.update();
      const price = await oracle.consult(cash.address, ETH);
      const antBalance = await cash.balanceOf(ant.address);

      await cash.connect(ant).approve(treasury.address, antBalance);
      await expect(treasury.connect(ant).buyBonds(antBalance))
        .to.emit(treasury, 'BoughtBonds')
        .withArgs(ant.address, antBalance);

      expect(await cash.balanceOf(ant.address)).to.eq(ZERO);
      expect(await bond.balanceOf(ant.address)).to.eq(antBalance.mul(ETH).div(price));
    });

    it('should work correctly when cash price is below $1', async () => {
      await cash.connect(ant).approve(router.address, swapAmount);
      await router
        .connect(ant)
        .swapExactTokensForTokens(
          swapAmount,
          ZERO,
          [cash.address, dai.address],
          ant.address,
          (await latestBlocktime(provider)) + 1800
        );
      await advanceTimeAndBlock(provider, Number(await oracle.PERIOD()));

      await oracle.update();
      const price = await oracle.consult(cash.address, ETH);
      const antBalance = await cash.balanceOf(ant.address);

      await cash.connect(ant).approve(treasury.address, antBalance);
      await treasury.connect(ant).buyBonds(antBalance);

      expect(await cash.balanceOf(ant.address)).to.eq(ZERO);
      expect(await bond.balanceOf(ant.address)).to.eq(antBalance.mul(ETH).div(price));
    });

    it('should work correctly when cash price is above $1', async () => {
      await dai.connect(operator).mint(ant.address, swapAmount);
      await dai.connect(ant).approve(router.address, swapAmount);
      await router
        .connect(ant)
        .swapExactTokensForTokens(
          swapAmount,
          ZERO,
          [dai.address, cash.address],
          ant.address,
          (await latestBlocktime(provider)) + 1800
        );
      await advanceTimeAndBlock(provider, Number(await oracle.PERIOD()));

      await oracle.update();
      const price = await oracle.consult(cash.address, ETH);
      const antBalance = await cash.balanceOf(ant.address);

      await cash.connect(ant).approve(treasury.address, antBalance);
      await treasury.connect(ant).buyBonds(antBalance);

      expect(await cash.balanceOf(ant.address)).to.eq(ZERO);
      expect(await bond.balanceOf(ant.address)).to.eq(antBalance.mul(ETH).div(price));
    });

    it('should fail when user tries to purchase bonds with zero amount', async () => {
      await expect(treasury.connect(ant).buyBonds(ZERO)).to.revertedWith(
        'Treasury: cannot purchase bonds with zero amount'
      );
    });
  });

  describe('#redeemBonds', () => {
    const swapAmount = ETH.sub(ETH.div(4));

    beforeEach('buy bonds', async () => {
      await Promise.all([
        dai.connect(operator).mint(ant.address, swapAmount),
        dai.connect(ant).approve(router.address, swapAmount),
      ]);
      await cash.connect(operator).mint(operator.address, ETH.mul(10));
      await bond.connect(operator).mint(operator.address, ETH.mul(100));
      await cash.connect(operator).transferOperator(treasury.address);
      await bond.connect(operator).transferOperator(treasury.address);
    });

    it('should work correctly', async () => {
      await router
        .connect(ant)
        .swapExactTokensForTokens(
          swapAmount,
          ZERO,
          [dai.address, cash.address],
          ant.address,
          (await latestBlocktime(provider)) + 1800
        );
      await advanceTimeAndBlock(provider, Number(await treasury.allocationDelay()));
      await treasury.connect(operator).allocateSeigniorage();
      await cash.connect(ant).transfer(treasury.address, await cash.balanceOf(ant.address));

      const redeemAmount = await cash.balanceOf(treasury.address);

      await bond.connect(operator).transfer(ant.address, redeemAmount);
      await bond.connect(ant).approve(treasury.address, redeemAmount);
      await expect(treasury.connect(ant).redeemBonds(redeemAmount))
        .to.emit(treasury, 'RedeemedBonds')
        .withArgs(ant.address, redeemAmount);

      expect(await bond.balanceOf(ant.address)).to.eq(ZERO); // 1:1
      expect(await cash.balanceOf(ant.address)).to.eq(redeemAmount);
    });

    it("should drain over seigniorage and even contract's budget", async () => {
      await router
        .connect(ant)
        .swapExactTokensForTokens(
          swapAmount,
          ZERO,
          [dai.address, cash.address],
          ant.address,
          (await latestBlocktime(provider)) + 1800
        );
      await advanceTimeAndBlock(provider, Number(await treasury.allocationDelay()));
      await treasury.connect(operator).allocateSeigniorage();
      await cash.connect(operator).transfer(treasury.address, ETH);

      const treasuryBalance = await cash.balanceOf(treasury.address);
      const cashBalance = await cash.balanceOf(ant.address);
      const redeemAmount = treasuryBalance.add(cashBalance);

      await cash.connect(ant).transfer(treasury.address, cashBalance);
      await bond.connect(operator).transfer(ant.address, redeemAmount);
      await bond.connect(ant).approve(treasury.address, redeemAmount);
      await treasury.connect(ant).redeemBonds(redeemAmount);

      expect(await bond.balanceOf(ant.address)).to.eq(ZERO);
      expect(await cash.balanceOf(ant.address)).to.eq(redeemAmount); // 1:1
    });

    it('should fail when user tries to redeem bonds with zero amount', async () => {
      await expect(treasury.connect(ant).redeemBonds(ZERO)).to.revertedWith(
        'Treasury: cannot redeem bonds with zero amount'
      );
    });

    it('should fail when cash price is below $1+ε', async () => {
      await expect(treasury.connect(ant).redeemBonds(ZERO.add(1))).to.revertedWith(
        'Treasury: bond redemption failed; basis cash remains depegged.'
      );
    });

    it("should fail when user tries to redeem bonds with over contract's budget", async () => {
      await router
        .connect(ant)
        .swapExactTokensForTokens(
          swapAmount,
          ZERO,
          [dai.address, cash.address],
          ant.address,
          (await latestBlocktime(provider)) + 1800
        );
      await advanceTimeAndBlock(provider, Number(await treasury.allocationDelay()));
      await treasury.connect(operator).allocateSeigniorage();

      const treasuryBalance = await cash.balanceOf(treasury.address);
      await expect(treasury.connect(ant).redeemBonds(treasuryBalance.add(1))).to.revertedWith(
        'Treasury: treasury has no more budget'
      );
    });
  });
});
