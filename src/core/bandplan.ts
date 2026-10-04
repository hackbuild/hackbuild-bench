/**
 * Bands worth naming on a spectrum axis. Where regions allocate differently,
 * the edges follow IARU region 2 and the US.
 */

export interface Band {
  lowHz: number
  highHz: number
  label: string
}

export const BAND_PLAN: Band[] = [
  { lowHz: 530e3, highHz: 1700e3, label: 'am broadcast' },
  { lowHz: 1.8e6, highHz: 2.0e6, label: '160 m' },
  { lowHz: 3.5e6, highHz: 4.0e6, label: '80 m' },
  { lowHz: 5.9e6, highHz: 6.2e6, label: '49 m shortwave' },
  { lowHz: 7.0e6, highHz: 7.3e6, label: '40 m' },
  { lowHz: 9.4e6, highHz: 9.9e6, label: '31 m shortwave' },
  { lowHz: 10.1e6, highHz: 10.15e6, label: '30 m' },
  { lowHz: 11.6e6, highHz: 12.1e6, label: '25 m shortwave' },
  { lowHz: 14.0e6, highHz: 14.35e6, label: '20 m' },
  { lowHz: 18.068e6, highHz: 18.168e6, label: '17 m' },
  { lowHz: 21.0e6, highHz: 21.45e6, label: '15 m' },
  { lowHz: 24.89e6, highHz: 24.99e6, label: '12 m' },
  { lowHz: 26.965e6, highHz: 27.405e6, label: 'cb' },
  { lowHz: 28.0e6, highHz: 29.7e6, label: '10 m' },
  { lowHz: 50e6, highHz: 54e6, label: '6 m' },
  { lowHz: 87.5e6, highHz: 108e6, label: 'fm broadcast' },
  { lowHz: 108e6, highHz: 118e6, label: 'air nav' },
  { lowHz: 118e6, highHz: 137e6, label: 'air band' },
  { lowHz: 137e6, highHz: 138e6, label: 'weather sats' },
  { lowHz: 144e6, highHz: 148e6, label: '2 m' },
  { lowHz: 156e6, highHz: 162.025e6, label: 'marine' },
  { lowHz: 162.4e6, highHz: 162.55e6, label: 'noaa weather' },
  { lowHz: 222e6, highHz: 225e6, label: '1.25 m' },
  { lowHz: 420e6, highHz: 450e6, label: '70 cm' },
  { lowHz: 433.05e6, highHz: 434.79e6, label: '433 ism' },
  { lowHz: 462.55e6, highHz: 467.725e6, label: 'frs gmrs' },
  { lowHz: 902e6, highHz: 928e6, label: '915 ism' },
  { lowHz: 1089e6, highHz: 1091e6, label: 'ads-b' },
  { lowHz: 1240e6, highHz: 1300e6, label: '23 cm' },
  { lowHz: 1574.4e6, highHz: 1576.4e6, label: 'gps l1' },
  { lowHz: 2400e6, highHz: 2483.5e6, label: '2.4 ghz ism' },
]
