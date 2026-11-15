import Cash from "../models/cash.model.js";
import { Op } from "sequelize";

export const getCashPositionData = async ({
  start_date,
  end_date,
  organization,
  status = "ALL",
}) => {
  const where = {
    as_at_date: {
      [Op.between]: [start_date, end_date],
    },
  };

  if (organization) {
    where.organization = organization;
  }

  if (status && status !== "ALL") {
    where.status = status;
  }

  // FIX: organization and as_at_date are now selected, and rows are newest first.
  // Previously neither was returned, so "latest balance" was really "whichever row came first".
  return Cash.findAll({
    where,
    attributes: ["organization", "account_name", "currency", "balance", "as_at_date"],
    order: [
      ["as_at_date", "DESC"],
      ["account_name", "ASC"],
    ],
  });
};

const dayValue = (value) => {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

export const groupCashPositionData = (rows) => {
  // Step 1: keep only the newest balance per organization + account + currency.
  // This no longer depends on the order the rows arrive in.
  const latestRecords = new Map();

  rows.forEach((row) => {
    const key = `${row.organization}|${row.account_name}|${row.currency}`;
    const current = latestRecords.get(key);

    if (!current || dayValue(row.as_at_date) > dayValue(current.as_at_date)) {
      latestRecords.set(key, row);
    }
  });

  // Step 2: add the organizations together per account, so "All DADs" shows
  // the combined balance of every DAD's accounts instead of just one of them.
  const formatted = {};

  latestRecords.forEach(({ account_name, currency, balance }) => {
    if (!formatted[account_name]) {
      formatted[account_name] = {
        account_name,
        GHS: 0,
        USD: 0,
        GBP: 0,
        EUR: 0,
      };
    }

    formatted[account_name][currency] =
      (formatted[account_name][currency] || 0) + Number(balance);
  });

  return Object.values(formatted);
};

export const totalCashPositionSummary = (grouped) => {
  return grouped.reduce(
    (totals, row) => {
      totals.GHS += row.GHS;
      totals.USD += row.USD;
      totals.GBP += row.GBP;
      totals.EUR += row.EUR;
      return totals;
    },
    { GHS: 0, USD: 0, GBP: 0, EUR: 0 },
  );
};
