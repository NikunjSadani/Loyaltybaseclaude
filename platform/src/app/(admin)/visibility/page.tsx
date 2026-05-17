'use client';

import { useState } from 'react';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  MapPin,
  Clock,
  Eye,
  Flag,
  ChevronLeft,
  ChevronRight,
  Search,
} from 'lucide-react';

type VisTab = 'queue' | 'fraud';

interface VisibilityItem {
  id: string;
  partnerId: string;
  partnerName: string;
  outletId: string;
  territory: string;
  visibilityType: string;
  imageUrl: string;
  uploadTime: string;
  geoLat: number;
  geoLng: number;
  geoAccuracy: string;
  captureTime: string;
  exifValid: boolean;
  submittedBy: string;
}

interface FraudItem {
  id: string;
  partnerId: string;
  partnerName: string;
  imageUrl: string;
  detectionReason: string;
  matchedSubmissionId: string;
  similarity: number;
  uploadTime: string;
  status: 'FLAGGED' | 'DISMISSED';
}

const VISIBILITY_QUEUE: VisibilityItem[] = [
  {
    id: 'VIS001', partnerId: 'P001', partnerName: 'Sharma General Store', outletId: 'OUT-MH-2841',
    territory: 'Mumbai West', visibilityType: 'Cooler Branding', uploadTime: '2025-04-30 08:42',
    geoLat: 19.1234, geoLng: 72.8765, geoAccuracy: '±8m', captureTime: '2025-04-30 08:41',
    exifValid: true, imageUrl: 'https://placehold.co/600x400/c8e6c9/1b5e20?text=Cooler+Branding',
    submittedBy: 'Rohit Verma',
  },
  {
    id: 'VIS002', partnerId: 'P002', partnerName: 'Ramesh Traders', outletId: 'OUT-DL-1034',
    territory: 'Delhi NCR', visibilityType: 'Shelf Display', uploadTime: '2025-04-30 09:15',
    geoLat: 28.6139, geoLng: 77.2090, geoAccuracy: '±12m', captureTime: '2025-04-30 09:14',
    exifValid: true, imageUrl: 'https://placehold.co/600x400/c8e6c9/1b5e20?text=Shelf+Display',
    submittedBy: 'Sanjay Kumar',
  },
  {
    id: 'VIS003', partnerId: 'P003', partnerName: 'Patel Kirana', outletId: 'OUT-GJ-4521',
    territory: 'Ahmedabad', visibilityType: 'Window Banner', uploadTime: '2025-04-30 10:03',
    geoLat: 23.0225, geoLng: 72.5714, geoAccuracy: '±25m', captureTime: '2025-04-29 16:32',
    exifValid: false, imageUrl: 'https://placehold.co/600x400/c8e6c9/1b5e20?text=Window+Banner',
    submittedBy: 'Anita Patel',
  },
  {
    id: 'VIS004', partnerId: 'P005', partnerName: 'K. Krishnamurthy & Sons', outletId: 'OUT-TN-8820',
    territory: 'Chennai', visibilityType: 'Floor Stand', uploadTime: '2025-04-30 11:20',
    geoLat: 13.0827, geoLng: 80.2707, geoAccuracy: '±6m', captureTime: '2025-04-30 11:18',
    exifValid: true, imageUrl: 'https://placehold.co/600x400/c8e6c9/1b5e20?text=Floor+Stand',
    submittedBy: 'Mohan Raj',
  },
];

const FRAUD_LOG: FraudItem[] = [
  {
    id: 'FRD001', partnerId: 'P088', partnerName: 'Rajiv Stores', imageUrl: 'https://placehold.co/300x200/ffcdd2/b71c1c?text=Flagged+Image+1',
    detectionReason: 'Perceptual hash similarity 94% with VIS-7821 (Suresh Kirana, same outlet)',
    matchedSubmissionId: 'VIS-7821', similarity: 94, uploadTime: '2025-04-29 14:22', status: 'FLAGGED',
  },
  {
    id: 'FRD002', partnerId: 'P112', partnerName: 'Meena Provisions', imageUrl: 'https://placehold.co/300x200/ffcdd2/b71c1c?text=Flagged+Image+2',
    detectionReason: 'EXIF capture time is 22 hours before submission — outside 24h window',
    matchedSubmissionId: '—', similarity: 0, uploadTime: '2025-04-28 09:05', status: 'FLAGGED',
  },
  {
    id: 'FRD003', partnerId: 'P203', partnerName: 'Ganesh Mart', imageUrl: 'https://placehold.co/300x200/ffcdd2/b71c1c?text=Flagged+Image+3',
    detectionReason: 'GPS coordinates within 15m of VIS-6503 (different partner, submitted 2 hrs earlier)',
    matchedSubmissionId: 'VIS-6503', similarity: 0, uploadTime: '2025-04-27 16:44', status: 'DISMISSED',
  },
  {
    id: 'FRD004', partnerId: 'P341', partnerName: 'Lakshmi Kirana', imageUrl: 'https://placehold.co/300x200/ffcdd2/b71c1c?text=Flagged+Image+4',
    detectionReason: 'Exact MD5 hash duplicate of VIS-8821 submitted same day',
    matchedSubmissionId: 'VIS-8821', similarity: 100, uploadTime: '2025-04-30 07:11', status: 'FLAGGED',
  },
];

const VIS_TYPE_COLORS: Record<string, string> = {
  'Cooler Branding': 'bg-blue-100 text-blue-700',
  'Shelf Display': 'bg-green-100 text-green-700',
  'Window Banner': 'bg-purple-100 text-purple-700',
  'Floor Stand': 'bg-amber-100 text-amber-700',
};

export default function VisibilityPage() {
  const [tab, setTab] = useState<VisTab>('queue');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const pendingItems = VISIBILITY_QUEUE.filter(
    (v) => !approved.has(v.id) && !rejected.has(v.id)
  );

  const currentItem = pendingItems[currentIndex] ?? VISIBILITY_QUEUE[0];
  const approvedToday = approved.size;
  const rejectedToday = rejected.size;

  const handleApprove = () => {
    if (!currentItem) return;
    setApproved((s) => new Set([...s, currentItem.id]));
    if (currentIndex >= pendingItems.length - 1) setCurrentIndex(Math.max(0, currentIndex - 1));
  };

  const handleReject = () => {
    if (!currentItem) return;
    setRejected((s) => new Set([...s, currentItem.id]));
    if (currentIndex >= pendingItems.length - 1) setCurrentIndex(Math.max(0, currentIndex - 1));
  };

  const filteredFraud = FRAUD_LOG.filter(
    (f) =>
      !search ||
      f.partnerName.toLowerCase().includes(search.toLowerCase()) ||
      f.detectionReason.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-5 fade-in">
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Pending Review', value: pendingItems.length, color: 'text-amber-600 bg-amber-50', icon: Clock },
          { label: 'Approved Today', value: approvedToday, color: 'text-green-600 bg-green-50', icon: CheckCircle },
          { label: 'Rejected Today', value: rejectedToday, color: 'text-red-600 bg-red-50', icon: XCircle },
          { label: 'Suspected Duplicate', value: FRAUD_LOG.filter((f) => f.status === 'FLAGGED').length, color: 'text-orange-600 bg-orange-50', icon: AlertTriangle },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
              <div className={`p-2 rounded-lg ${s.color}`}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white border border-gray-200 rounded-xl p-1 w-fit">
        <button
          onClick={() => setTab('queue')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === 'queue' ? 'bg-[#C8102E] text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          <span className="flex items-center gap-2">
            <Eye className="w-4 h-4" />
            Approval Queue ({pendingItems.length})
          </span>
        </button>
        <button
          onClick={() => setTab('fraud')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === 'fraud' ? 'bg-[#C8102E] text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          <span className="flex items-center gap-2">
            <Flag className="w-4 h-4" />
            Fraud Log ({FRAUD_LOG.filter((f) => f.status === 'FLAGGED').length})
          </span>
        </button>
      </div>

      {/* Queue Tab */}
      {tab === 'queue' && (
        <>
          {pendingItems.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 py-20 text-center">
              <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-4" />
              <p className="text-base font-semibold text-gray-700">All submissions reviewed!</p>
              <p className="text-sm text-gray-400 mt-1">No pending visibility approvals in the queue.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
              {/* Image viewer */}
              <div className="lg:col-span-3 bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-600">
                      {currentIndex + 1} / {pendingItems.length} pending
                    </span>
                    {currentItem && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${VIS_TYPE_COLORS[currentItem.visibilityType] ?? 'bg-gray-100 text-gray-700'}`}>
                        {currentItem.visibilityType}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCurrentIndex(Math.max(0, currentIndex - 1))}
                      disabled={currentIndex === 0}
                      className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-40 transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4 text-gray-500" />
                    </button>
                    <button
                      onClick={() => setCurrentIndex(Math.min(pendingItems.length - 1, currentIndex + 1))}
                      disabled={currentIndex === pendingItems.length - 1}
                      className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-40 transition-colors"
                    >
                      <ChevronRight className="w-4 h-4 text-gray-500" />
                    </button>
                  </div>
                </div>

                {currentItem && (
                  <>
                    <div className="bg-gray-900 flex items-center justify-center" style={{ minHeight: 300 }}>
                      <img
                        src={currentItem.imageUrl}
                        alt="Visibility submission"
                        className="max-w-full max-h-72 object-contain"
                      />
                    </div>

                    <div className="p-4 flex gap-3">
                      <button
                        onClick={handleApprove}
                        className="flex-1 flex items-center justify-center gap-2 py-3 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors"
                      >
                        <CheckCircle className="w-5 h-5" />
                        Approve
                      </button>
                      <button
                        onClick={handleReject}
                        className="flex-1 flex items-center justify-center gap-2 py-3 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors"
                      >
                        <XCircle className="w-5 h-5" />
                        Reject
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Submission details */}
              <div className="lg:col-span-2 space-y-4">
                {currentItem && (
                  <>
                    <div className="bg-white rounded-xl border border-gray-200 p-4">
                      <h3 className="text-sm font-semibold text-gray-800 mb-3">Outlet Details</h3>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-gray-500">Partner</span>
                          <span className="font-medium text-gray-900">{currentItem.partnerName}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Outlet ID</span>
                          <span className="font-mono text-gray-700">{currentItem.outletId}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Territory</span>
                          <span className="text-gray-700">{currentItem.territory}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Submitted by</span>
                          <span className="text-gray-700">{currentItem.submittedBy}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Upload Time</span>
                          <span className="text-gray-700">{currentItem.uploadTime}</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-white rounded-xl border border-gray-200 p-4">
                      <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-[#C8102E]" />
                        Geo-tag Verification
                      </h3>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-gray-500">Latitude</span>
                          <span className="font-mono text-gray-700">{currentItem.geoLat}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Longitude</span>
                          <span className="font-mono text-gray-700">{currentItem.geoLng}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Accuracy</span>
                          <span className="text-gray-700">{currentItem.geoAccuracy}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Capture Time</span>
                          <span className="text-gray-700">{currentItem.captureTime}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-gray-500">EXIF Valid</span>
                          <span className={`flex items-center gap-1 font-medium ${currentItem.exifValid ? 'text-green-600' : 'text-red-600'}`}>
                            {currentItem.exifValid ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                            {currentItem.exifValid ? 'Valid' : 'Invalid — outside 24h window'}
                          </span>
                        </div>
                      </div>
                      {!currentItem.exifValid && (
                        <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-700 flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                          EXIF timestamp is outside the 24-hour window. Review carefully before approving.
                        </div>
                      )}
                    </div>

                    {/* Queue list */}
                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-4 py-3 border-b border-gray-100">
                        <p className="text-xs font-semibold text-gray-600">Queue</p>
                      </div>
                      <div className="divide-y divide-gray-50 max-h-48 overflow-y-auto">
                        {pendingItems.map((item, idx) => (
                          <button
                            key={item.id}
                            onClick={() => setCurrentIndex(idx)}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 transition-colors ${
                              idx === currentIndex ? 'bg-red-50' : ''
                            }`}
                          >
                            <img
                              src={item.imageUrl}
                              alt=""
                              className="w-10 h-7 rounded object-cover flex-shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-gray-800 truncate">{item.partnerName}</p>
                              <p className="text-xs text-gray-400">{item.visibilityType}</p>
                            </div>
                            {!item.exifValid && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Fraud Log Tab */}
      {tab === 'fraud' && (
        <div className="space-y-4">
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fraud log..."
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredFraud.map((fraud) => (
              <div
                key={fraud.id}
                className={`bg-white rounded-xl border overflow-hidden ${
                  fraud.status === 'FLAGGED' ? 'border-red-200' : 'border-gray-200'
                }`}
              >
                <div className={`px-4 py-2 flex items-center justify-between ${
                  fraud.status === 'FLAGGED' ? 'bg-red-50 border-b border-red-100' : 'bg-gray-50 border-b border-gray-100'
                }`}>
                  <span className={`text-xs font-semibold ${fraud.status === 'FLAGGED' ? 'text-red-700' : 'text-gray-500'}`}>
                    {fraud.status === 'FLAGGED' ? '⚠ SUSPECTED DUPLICATE' : '✓ DISMISSED'}
                  </span>
                  <span className="text-xs text-gray-400">{fraud.id}</span>
                </div>
                <div className="p-4 flex gap-4">
                  <img
                    src={fraud.imageUrl}
                    alt="Fraud evidence"
                    className="w-28 h-20 rounded-lg object-cover flex-shrink-0"
                  />
                  <div className="flex-1 space-y-1.5">
                    <p className="text-sm font-semibold text-gray-900">{fraud.partnerName}</p>
                    <p className="text-xs text-gray-500">Uploaded: {fraud.uploadTime}</p>
                    <div className="bg-red-50 border border-red-100 rounded px-2 py-1.5">
                      <p className="text-xs text-red-700">{fraud.detectionReason}</p>
                    </div>
                    {fraud.similarity > 0 && (
                      <p className="text-xs text-gray-500">
                        Similarity: <span className="font-semibold text-red-600">{fraud.similarity}%</span> · Matched: {fraud.matchedSubmissionId}
                      </p>
                    )}
                  </div>
                </div>
                {fraud.status === 'FLAGGED' && (
                  <div className="px-4 pb-4 flex gap-2">
                    <button className="flex-1 py-2 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 transition-colors">
                      Confirm Duplicate
                    </button>
                    <button className="flex-1 py-2 border border-gray-300 text-gray-700 rounded-lg text-xs font-medium hover:bg-gray-50 transition-colors">
                      Dismiss Flag
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
