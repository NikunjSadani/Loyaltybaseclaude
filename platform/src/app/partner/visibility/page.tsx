'use client'

import { useState, useRef } from 'react'
import { Camera, MapPin, Upload, CheckCircle, XCircle, Clock, AlertTriangle, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const statusConfig = {
  PENDING: { label: 'Pending Review', color: 'bg-yellow-100 text-yellow-800', icon: Clock },
  APPROVED: { label: 'Approved', color: 'bg-green-100 text-green-800', icon: CheckCircle },
  REJECTED: { label: 'Rejected', color: 'bg-red-100 text-red-800', icon: XCircle },
  SUSPECTED_DUPLICATE: { label: 'Under Investigation', color: 'bg-orange-100 text-orange-800', icon: AlertTriangle },
  AUTO_REJECTED: { label: 'Auto Rejected', color: 'bg-red-200 text-red-900', icon: XCircle },
}

const programs = [
  { id: 'p1', name: 'Shelf Branding', description: 'Upload photo of branded shelf display' },
  { id: 'p2', name: 'Counter Display', description: 'Upload photo of counter display unit' },
  { id: 'p3', name: 'Standee', description: 'Upload photo of standee placement' },
  { id: 'p4', name: 'Glow Sign', description: 'Upload photo of illuminated glow sign' },
  { id: 'p5', name: 'Cooler Branding', description: 'Upload photo of branded cooler unit' },
]

interface Submission {
  id: string
  programName: string
  outletName: string
  status: keyof typeof statusConfig
  submittedAt: string
  rejectionReason?: string
  payoutAmount?: number
}

export default function VisibilityPage() {
  const [submissions] = useState<Submission[]>([
    { id: 's1', programName: 'Shelf Branding', outletName: 'Ramesh General Store', status: 'APPROVED', submittedAt: '2026-05-10', payoutAmount: 50000 },
    { id: 's2', programName: 'Counter Display', outletName: 'Meena Kirana', status: 'PENDING', submittedAt: '2026-05-14' },
    { id: 's3', programName: 'Standee', outletName: 'Ramesh General Store', status: 'REJECTED', submittedAt: '2026-05-08', rejectionReason: 'Standee not properly visible. Brand name obscured.' },
  ])
  const [showUpload, setShowUpload] = useState(false)
  const [selectedProgram, setSelectedProgram] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [geoLocation, setGeoLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [geoLoading, setGeoLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ success: boolean; message: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { alert('Image must be under 2MB'); return }
    setImageFile(file)
    const reader = new FileReader()
    reader.onload = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const captureGeo = () => {
    setGeoLoading(true)
    navigator.geolocation.getCurrentPosition(
      pos => { setGeoLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGeoLoading(false) },
      () => { alert('Unable to get location. Please enable location access.'); setGeoLoading(false) }
    )
  }

  const handleSubmit = async () => {
    if (!imageFile || !selectedProgram || !geoLocation) return
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('image', imageFile)
      formData.append('programId', selectedProgram)
      formData.append('geoLat', geoLocation.lat.toString())
      formData.append('geoLng', geoLocation.lng.toString())
      const token = localStorage.getItem('token')
      const res = await fetch('/api/visibility/submit', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData })
      const data = await res.json()
      if (data.success) {
        setUploadResult({ success: true, message: 'Visibility submitted successfully! It will be reviewed within 3 working days.' })
        setShowUpload(false)
        setImageFile(null); setImagePreview(null); setGeoLocation(null); setSelectedProgram('')
      } else {
        setUploadResult({ success: false, message: data.error || 'Submission failed. Please try again.' })
      }
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <div className="bg-[#1A1A2E] text-white p-4">
        <h1 className="text-lg font-bold">Visibility Execution</h1>
        <p className="text-xs text-gray-300 mt-0.5">Submit branding photos for visibility incentives</p>
      </div>

      <div className="p-4 space-y-4">
        {uploadResult && (
          <div className={`p-3 rounded-lg flex items-start gap-2 ${uploadResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
            {uploadResult.success ? <CheckCircle className="h-4 w-4 text-green-600 mt-0.5 flex-shrink-0" /> : <XCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />}
            <p className={`text-sm ${uploadResult.success ? 'text-green-700' : 'text-red-700'}`}>{uploadResult.message}</p>
          </div>
        )}

        <Button onClick={() => setShowUpload(true)} className="w-full bg-[#C8102E] hover:bg-[#a00d24] text-white py-3">
          <Camera className="h-5 w-5 mr-2" /> Submit New Visibility Photo
        </Button>

        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">My Submissions</h2>
          <div className="space-y-3">
            {submissions.map(sub => {
              const cfg = statusConfig[sub.status]
              const Icon = cfg.icon
              return (
                <Card key={sub.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-gray-900">{sub.programName}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{sub.outletName}</p>
                        <p className="text-xs text-gray-400 mt-1">{new Date(sub.submittedAt).toLocaleDateString('en-IN')}</p>
                        {sub.rejectionReason && <p className="text-xs text-red-600 mt-2 bg-red-50 p-2 rounded">Reason: {sub.rejectionReason}</p>}
                        {sub.payoutAmount && <p className="text-xs text-green-600 font-medium mt-1">Payout: ₹{(sub.payoutAmount / 100).toFixed(2)}</p>}
                      </div>
                      <span className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium ${cfg.color}`}>
                        <Icon className="h-3 w-3" />{cfg.label}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      </div>

      {/* Upload Sheet */}
      {showUpload && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className="bg-white w-full md:max-w-md md:rounded-xl rounded-t-2xl p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-[#1A1A2E]">Submit Visibility Photo</h2>
              <button onClick={() => setShowUpload(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 block mb-2">Visibility Program *</label>
              <select value={selectedProgram} onChange={e => setSelectedProgram(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]">
                <option value="">Select program...</option>
                {programs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {selectedProgram && <p className="text-xs text-gray-500 mt-1">{programs.find(p => p.id === selectedProgram)?.description}</p>}
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 block mb-2">Photo * (max 2MB)</label>
              <input type="file" accept="image/*" capture="environment" ref={fileRef} onChange={handleFileChange} className="hidden" />
              {imagePreview ? (
                <div className="relative">
                  <img src={imagePreview} alt="Preview" className="w-full h-48 object-cover rounded-lg" />
                  <button onClick={() => { setImageFile(null); setImagePreview(null) }} className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">✕</button>
                </div>
              ) : (
                <button onClick={() => fileRef.current?.click()} className="w-full h-32 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-2 hover:border-[#C8102E] transition-colors">
                  <Upload className="h-6 w-6 text-gray-400" />
                  <span className="text-sm text-gray-500">Tap to capture or upload photo</span>
                </button>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 block mb-2">Location *</label>
              {geoLocation ? (
                <div className="flex items-center gap-2 p-2 bg-green-50 rounded-lg border border-green-200">
                  <MapPin className="h-4 w-4 text-green-600" />
                  <span className="text-xs text-green-700">{geoLocation.lat.toFixed(6)}, {geoLocation.lng.toFixed(6)}</span>
                  <button onClick={() => setGeoLocation(null)} className="ml-auto text-xs text-gray-400">✕</button>
                </div>
              ) : (
                <Button onClick={captureGeo} disabled={geoLoading} variant="outline" className="w-full border-[#C8102E] text-[#C8102E]">
                  {geoLoading ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Getting location...</> : <><MapPin className="h-4 w-4 mr-2" />Capture Current Location</>}
                </Button>
              )}
            </div>

            <div className="pt-2">
              <p className="text-xs text-gray-400 mb-3">Images are automatically checked for duplicates. Geo-tag and timestamp are required.</p>
              <Button onClick={handleSubmit} disabled={!imageFile || !selectedProgram || !geoLocation || uploading} className="w-full bg-[#C8102E] hover:bg-[#a00d24] text-white">
                {uploading ? <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Submitting...</> : 'Submit Visibility Photo'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
