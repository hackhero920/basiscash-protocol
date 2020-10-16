const contract = require('@truffle/contract');
const knownContracts = require('./known-contracts');

const Cash = artifacts.require('Cash');
const Bond = artifacts.require('Bond');
const Share = artifacts.require('Share');
const IERC20 = artifacts.require('IERC20');
const MockDai = artifacts.require('MockDai');

const Oracle = artifacts.require('Oracle')
const Boardroom = artifacts.require('Boardroom')
const Treasury = artifacts.require('Treasury')

const UniswapV2Factory = contract(require('@uniswap/v2-core/build/UniswapV2Factory.json'));
const UniswapV2Router02 = contract(require('@uniswap/v2-periphery/build/UniswapV2Router02.json'));
const UniswapV2Pair = contract(require('@uniswap/v2-core/build/UniswapV2Pair.json'));

async function migration(deployer, network, accounts) {
  [UniswapV2Factory, UniswapV2Router02, UniswapV2Pair].forEach(contract => {
    contract.setProvider(web3._provider);
    contract.defaults({ from: accounts[0] });
  });

  let uniswap, uniswapRouter;
  if (network === 'development') {
    console.log('Deploying uniswap on development network.');
    await deployer.deploy(UniswapV2Factory, accounts[0]);
    await deployer.deploy(UniswapV2Router02, accounts[0], accounts[0]);

    uniswap = await UniswapV2Factory.deployed();
    uniswapRouter = await UniswapV2Router02.deployed();

  } else {
    uniswap = await UniswapV2Factory.at(knownContracts.UniswapV2Factory[network]);
    uniswapRouter = await UniswapV2Router02.at(knownContracts.UniswapV2Router02[network]);
  }

  const dai = network === 'mainnet'
    ? await IERC20.at(knownContracts.DAI[network])
    : await MockDai.deployed();

  // 2. provide liquidity to BAC-DAI and BAS-DAI pair
  // if you don't provide liquidity to BAC-DAI and BAS-DAI pair after step 1 and before step 3,
  //  creating Oracle will fail with NO_RESERVES error.
  const unit = web3.utils.toBN(10 ** 18).toString();
  const max = web3.utils.toBN(10 ** 18).muln(10000).toString();

  const cash = await Cash.deployed();
  const share = await Share.deployed();

  console.log('Approving Uniswap on tokens for liquidity');
  await Promise.all([
    approveIfNot(cash, accounts[0], uniswapRouter.address, max),
    approveIfNot(share, accounts[0], uniswapRouter.address, max),
    approveIfNot(dai, accounts[0], uniswapRouter.address, max),
  ]);

  // WARNING: msg.sender must hold enough DAI to add liquidity to BAC-DAI & BAS-DAI pools
  // otherwise transaction will revert
  console.log('Adding liquidity to pools');
  await uniswapRouter.addLiquidity(
    cash.address, dai.address, unit, unit, unit, unit, accounts[0], deadline(),
  );
  await uniswapRouter.addLiquidity(
    share.address, dai.address, unit, unit, unit, unit, accounts[0],  deadline(),
  );

  console.log('\nPrices after providing liquidity');
  console.log('=================================');
  await checkPairPrice('BAC', cash.address, dai.address, uniswap, UniswapV2Pair);
  await checkPairPrice('BAS', share.address, dai.address, uniswap, UniswapV2Pair);

  // Deploy boardroom
  await deployer.deploy(Boardroom, cash.address, share.address);

  // 2. Deploy oracle for the pair between bac and dai
  await deployer.deploy(
    Oracle,
    uniswap.address,
    cash.address,
    dai.address,
  );

  await deployer.deploy(
    Treasury,
    cash.address,
    Bond.address,
    share.address,
    Oracle.address,
    dai.address,
    Boardroom.address,
  );
}

async function checkPairPrice(tokenSymbol, tokenAddr, daiAddr, uniswap, UniswapV2Pair) {
  const pair = await UniswapV2Pair.at(await uniswap.getPair(tokenAddr, daiAddr));
  console.log(`${tokenSymbol} Price: ${await pair.price0CumulativeLast()} ${await pair.price1CumulativeLast()}`);
}

async function approveIfNot(token, owner, spender, amount) {
  const allowance = await token.allowance(owner, spender);
  if (web3.utils.toBN(allowance).gte(web3.utils.toBN(amount))) {
    return;
  }
  await token.approve(spender, amount);
  console.log(` - Approved ${token.symbol ? (await token.symbol()) : token.address}`);
}

function deadline() {
  // 30 minutes
  return Math.floor(new Date().getTime() / 1000) + 1800;
}

module.exports = migration;