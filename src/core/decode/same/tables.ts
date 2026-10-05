/**
 * Names for SAME codes. Event codes follow 47 CFR 11.31 and the NWS list
 * that NOAA Weather Radio adds to it. Locations carry the US states and
 * territories plus every Arizona county, and any other county stays a raw
 * FIPS code.
 */

export const ORIGINATORS: Record<string, string> = {
  EAS: 'a broadcast or cable station',
  CIV: 'civil authorities',
  WXR: 'the national weather service',
  PEP: 'the primary entry point system',
}

export const EVENTS: Record<string, string> = {
  EAN: 'emergency action notification',
  EAT: 'emergency action termination',
  NIC: 'national information center',
  NPT: 'national periodic test',
  NAT: 'national audible test',
  NST: 'national silent test',
  RMT: 'required monthly test',
  RWT: 'required weekly test',
  ADR: 'administrative message',
  AVA: 'avalanche watch',
  AVW: 'avalanche warning',
  BLU: 'blue alert',
  BZW: 'blizzard warning',
  CAE: 'child abduction emergency',
  CDW: 'civil danger warning',
  CEM: 'civil emergency message',
  CFA: 'coastal flood watch',
  CFW: 'coastal flood warning',
  DMO: 'practice or demo warning',
  DSW: 'dust storm warning',
  EQW: 'earthquake warning',
  EVI: 'evacuation immediate',
  EWW: 'extreme wind warning',
  FFA: 'flash flood watch',
  FFS: 'flash flood statement',
  FFW: 'flash flood warning',
  FLA: 'flood watch',
  FLS: 'flood statement',
  FLW: 'flood warning',
  FRW: 'fire warning',
  FSW: 'flash freeze warning',
  FZW: 'freeze warning',
  HLS: 'hurricane statement',
  HMW: 'hazardous materials warning',
  HUA: 'hurricane watch',
  HUW: 'hurricane warning',
  HWA: 'high wind watch',
  HWW: 'high wind warning',
  LAE: 'local area emergency',
  LEW: 'law enforcement warning',
  NMN: 'network message notification',
  NUW: 'nuclear power plant warning',
  RHW: 'radiological hazard warning',
  SMW: 'special marine warning',
  SPS: 'special weather statement',
  SPW: 'shelter in place warning',
  SQW: 'snow squall warning',
  SSA: 'storm surge watch',
  SSW: 'storm surge warning',
  SVA: 'severe thunderstorm watch',
  SVR: 'severe thunderstorm warning',
  SVS: 'severe weather statement',
  TOA: 'tornado watch',
  TOE: '911 telephone outage emergency',
  TOR: 'tornado warning',
  TRA: 'tropical storm watch',
  TRW: 'tropical storm warning',
  TSA: 'tsunami watch',
  TSW: 'tsunami warning',
  VOW: 'volcano warning',
  WSA: 'winter storm watch',
  WSW: 'winter storm warning',
}

/** State FIPS code to postal abbreviation and name. */
export const STATES: Record<string, [string, string]> = {
  '01': ['al', 'alabama'], '02': ['ak', 'alaska'], '04': ['az', 'arizona'],
  '05': ['ar', 'arkansas'], '06': ['ca', 'california'], '08': ['co', 'colorado'],
  '09': ['ct', 'connecticut'], '10': ['de', 'delaware'], '11': ['dc', 'district of columbia'],
  '12': ['fl', 'florida'], '13': ['ga', 'georgia'], '15': ['hi', 'hawaii'],
  '16': ['id', 'idaho'], '17': ['il', 'illinois'], '18': ['in', 'indiana'],
  '19': ['ia', 'iowa'], '20': ['ks', 'kansas'], '21': ['ky', 'kentucky'],
  '22': ['la', 'louisiana'], '23': ['me', 'maine'], '24': ['md', 'maryland'],
  '25': ['ma', 'massachusetts'], '26': ['mi', 'michigan'], '27': ['mn', 'minnesota'],
  '28': ['ms', 'mississippi'], '29': ['mo', 'missouri'], '30': ['mt', 'montana'],
  '31': ['ne', 'nebraska'], '32': ['nv', 'nevada'], '33': ['nh', 'new hampshire'],
  '34': ['nj', 'new jersey'], '35': ['nm', 'new mexico'], '36': ['ny', 'new york'],
  '37': ['nc', 'north carolina'], '38': ['nd', 'north dakota'], '39': ['oh', 'ohio'],
  '40': ['ok', 'oklahoma'], '41': ['or', 'oregon'], '42': ['pa', 'pennsylvania'],
  '44': ['ri', 'rhode island'], '45': ['sc', 'south carolina'], '46': ['sd', 'south dakota'],
  '47': ['tn', 'tennessee'], '48': ['tx', 'texas'], '49': ['ut', 'utah'],
  '50': ['vt', 'vermont'], '51': ['va', 'virginia'], '53': ['wa', 'washington'],
  '54': ['wv', 'west virginia'], '55': ['wi', 'wisconsin'], '56': ['wy', 'wyoming'],
  '60': ['as', 'american samoa'], '66': ['gu', 'guam'], '69': ['mp', 'northern mariana islands'],
  '72': ['pr', 'puerto rico'], '78': ['vi', 'us virgin islands'],
}

/** Arizona county FIPS codes, state 04. */
export const AZ_COUNTIES: Record<string, string> = {
  '001': 'apache', '003': 'cochise', '005': 'coconino', '007': 'gila', '009': 'graham',
  '011': 'greenlee', '012': 'la paz', '013': 'maricopa', '015': 'mohave', '017': 'navajo',
  '019': 'pima', '021': 'pinal', '023': 'santa cruz', '025': 'yavapai', '027': 'yuma',
}

/** The P digit of PSSCCC, which ninth of the county is meant. */
export const SUBDIVISIONS: readonly string[] = [
  '', 'northwest', 'north central', 'northeast', 'west central', 'central', 'east central',
  'southwest', 'south central', 'southeast',
]
