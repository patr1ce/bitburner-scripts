import { StockSymbols as CompanyStockSymbols } from '/stocks/companies';
import { PortService } from "/service/lib";

export async function main(ns) {
    ns.disableLog("asleep");
    ns.disableLog("stock.buy");
    ns.disableLog("stock.sell");

    const stockInfo = new StockInfo(ns);
    const service = new PortService(ns, 5, stockInfo);
    await service.serve(stockInfo);
}

class StockInfo {
    constructor(ns) {
        this.ns = ns;
        this.lastUpdateTime = 1;
    }

    getStockInfo(symbol) {
        return getStockInfo(this.ns, symbol);
    }

    getAllStocks() {
        return getAllStocks(this.ns);
    }

    getPortfolioValue() {
        return getPortfolioValue(this.getAllStocks());
    }

    update() {
        // run at most once per minute
        const now = Date.now();
        if (now < this.lastUpdateTime + 1*60*1000) {
            return;
        }
        this.lastUpdateTime = now;

        tendStocks(this.ns);
    }
}

function tendStocks(ns) {
    const allStocks = getAllStocks(ns);
    
    // select stocks with <51% chance to increase price
    const stocksToSell = getBearStocks(allStocks, 0.51);
    // sell all those stocks
    sellStocks(ns, stocksToSell);
    
    // select stocks with >55% chance to increase price
    const stocksToBuy = getBullStocks(allStocks, 0.55);
    // buy the highest-rated stocks available
    buyStocks(ns, stocksToBuy);

    // keep of log of net worth change over time
    const portfolioValue = getPortfolioValue(allStocks);
    const cashValue = ns.getPlayer().money;
    const totalValue = portfolioValue + cashValue;
    ns.print(`Net worth: ${ns.nFormat(totalValue, "$0.000a")} = ${ns.nFormat(portfolioValue, "$0.0a")} stocks + ${ns.nFormat(cashValue, "$0.0a")} cash`);
}

export function getStockInfo(ns, symbol) {
    getStockInfo.allSymbols ||= ns.stock.getSymbols();
    if (symbol in CompanyStockSymbols) {
        // look up organization name
        symbol = CompanyStockSymbols[symbol];
    }
    if (!getStockInfo.allSymbols.includes(symbol)) {
        return null;
    }
    const pos = ns.stock.getPosition(symbol);
    const stock = {
        symbol: symbol,
        forecast: ns.stock.getForecast(symbol),
        volatility: ns.stock.getVolatility(symbol),
        askPrice: ns.stock.getAskPrice(symbol),
        bidPrice: ns.stock.getBidPrice(symbol),
        maxShares: ns.stock.getMaxShares(symbol),
        shares: pos[0],
        sharesAvgPrice: pos[1],
        sharesShort: pos[2],
        sharesAvgPriceShort: pos[3],
    };
    stock.netShares = stock.shares - stock.sharesShort;
    stock.netValue = stock.bidPrice * stock.shares - stock.askPrice * stock.sharesShort;
    stock.summary = `${stock.symbol}: ${stock.forecast.toFixed(3)} ± ${stock.volatility.toFixed(3)}`;
    return stock;
}

export function getAllStocks(ns) {
    // make a lookup table of all stocks and all their properties
    const stockSymbols = ns.stock.getSymbols();
    const stocks = {};
    for (const symbol of stockSymbols) {
        stocks[symbol] = getStockInfo(ns, symbol);
    }
    return stocks;
}

function getPortfolioValue(stocks) {
    let value = 0;
    for (const stock of Object.values(stocks)) {
        value += stock.netValue;
    }
    return value;
}

function getBullStocks(stocks, threshold=0.55) {
    // select stocks with at least threshold % chance to increase each tick
    const bullStocks = [];
    for (const stock of Object.values(stocks)) {
        if (stock.forecast - stock.volatility > threshold) {
            bullStocks.push(stock);
        }
    }
    return bullStocks;
}

function getBearStocks(stocks, threshold=0.48) {
    // select stocks with at most threshold % chance to increase each tick
    const bearStocks = [];
    for (const stock of Object.values(stocks)) {
        if (stock.forecast - stock.volatility < threshold) {
            bearStocks.push(stock);
        }
    }
    return bearStocks;
}


export function sellStocks(ns, stocksToSell) {
    for (const stock of stocksToSell) {
        if (stock.shares > 0) {
            const salePrice = ns.stock.sell(stock.symbol, stock.shares);
            if (salePrice != 0) {
                const saleTotal = salePrice * stock.shares;
                const saleCost = stock.sharesAvgPrice * stock.shares;
                const saleProfit = saleTotal - saleCost;
                stock.shares = 0;
                //ns.print(`Sold ${ns.nFormat(saleTotal, "$0.0a")} of ${stock.summary}`);
                ns.print(`Sold ${stock.summary} stock for ${ns.nFormat(saleProfit, "$0.0a")} profit`);
            }
        }
    }
}

function buyStocks(ns, stocksToBuy, moneyToSpend, maxTransactions=4) {
    // buy stocks, spending more money on higher rated stocks
    const bestStocks = stocksToBuy.sort((a,b)=>{
        return b.forecast - a.forecast; // descending
    });

    let transactions = 0;
    for (const stock of bestStocks) {
        const moneyRemaining = ns.getPlayer().money;
        // don't spend the last 5 million bux
        if (moneyRemaining < 5000000 || transactions >= maxTransactions) {
            return;
        }
        // spend up to half the money available on the highest rated stock
        // (the next stock will buy half as much)
        const moneyThisStock = moneyRemaining/2 - 100000;
        let numShares = moneyThisStock / stock.askPrice;
        
        numShares = Math.min(numShares, stock.maxShares - stock.shares - stock.sharesShort);
        const boughtPrice = ns.stock.buy(stock.symbol, numShares);
        if (boughtPrice != 0) {
            const boughtTotal = boughtPrice * numShares;
            transactions += 1;
            stock.shares += numShares;
            ns.print(`Bought ${ns.nFormat(boughtTotal, "$0.0a")} of ${stock.summary}`);
        }
    }
}
